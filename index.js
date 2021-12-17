import fs from 'fs/promises'
import process from 'process'
import got from 'got'
import { CookieJar } from 'tough-cookie'
import { WebhookClient, MessageEmbed } from 'discord.js'

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

require('dotenv').config();

/**
 * @classdesc Main class for the bot
 * 
 * @property {object} config - Configuration provided by the user, including secrets
 * @property {WebhookClient} webhook - Discord webhook client
 * @property {Got} api - Client for Fandom APIs, with stored cookies from [logging in]{@link ReportedPostsBot#fandomLogin}
 * @property {Set} cache - Reported posts that have already been setInterval
 * @property {NodeJS.Timeout} interval - [Polling function]{@link ReportedPostsBot#poll} interval
 */
class ReportedPostsBot {
	/**
	 * Initializes the Discord webhook, API client, and cache
	 */
	constructor() {
		this.config = {
			devMode: process.env.ENVIRONMENT?.toLowerCase()?.startsWith('dev'),
			webhook: {
				id: process.env.WEBHOOK_ID || null,
				token: process.env.WEBHOOK_TOKEN || null
			},
			fandom: {
				wiki: process.env.FANDOM_WIKI || null,
				domain: process.env.FANDOM_DOMAIN || 'fandom.com',
				username: process.env.FANDOM_USERNAME || null,
				password: process.env.FANDOM_PASSWORD || null
			},
			interval: (process.env.INTERVAL || 30) * 1000
		};

		if (this.config.devMode && process.env.DEV_WEBHOOK_ID && process.env.DEV_WEBHOOK_TOKEN) {
			this.config.webhook = {
				id: process.env.DEV_WEBHOOK_ID,
				token: process.env.DEV_WEBHOOK_TOKEN
			}
		}

		// Check for missing config
		if (Object.values(this.config)
			.map(v => !(v instanceof Object ? Object.values(v).includes(null) : v === null))
			.includes(false)
		) {
			this.finish();
			throw console.error('Missing required config variable(s)');
		}

		// Discord webhook
		this.webhook = new WebhookClient({
			id: this.config.webhook.id,
			token: this.config.webhook.token
		});

		// API client
		this.config.fandom.wikiUrl = this.getWikiUrl(this.config.fandom.wiki, this.config.fandom.domain);

		let pkg = require('./package.json');
		this.api = got.extend({
			cookieJar: new CookieJar(),
			headers: {
				'User-Agent': `${pkg.name} v${pkg.version} (${pkg.homepage})`
			}
		});

		// Cache
		this.cache = new Set();
		if (!this.config.devMode) {
			try {
				this.cache = new Set(require('./cache.json'));
				console.info('Loaded cache');
			} catch (err) {
				console.info('Didn\'t load cache');
			}
		}
	}

	/**
	 * Logs into Fandom in the API client
	 * @returns {Promise} - API response or error
	 */
	async fandomLogin() {
		return new Promise(async (resolve, reject) => {
			try {
				let response = await this.api.post(`https://services.${this.config.fandom.domain}/auth/token`, {
					form: {
						username: this.config.fandom.username,
						password: this.config.fandom.password
					},
					headers: {
						'X-Wikia-WikiaAppsID': 1234
					}
				}).json();
				console.info(`Logged into Fandom as ID ${response.user_id}`);
				resolve(response);
			} catch (err) {
				console.error('Failed to log in:', err.response.body);
				return await new Promise(resolve => setTimeout(async () => {
					resolve();
					return await this.fandomLogin();
				}, 10000))
			}
		});
	}

	/**
	 * Save this.cache to cache.json
	 */
	saveCache() {
		if (!this.config.devMode) fs.writeFile('cache.json', JSON.stringify(Array.from(this.cache)), () => {});
	}

	/**
	 * Utility to get a wiki URL from domain and interwiki
	 * @param {string} interwiki - Interwiki (subdomain or lang.subdomain)
	 * @param {string} domain - Root domain of the wiki and services (like fandom.com)
	 * @returns {string} - Root wiki URL
	 */
	getWikiUrl(interwiki, domain) {
		if (interwiki.includes('.')) {
			let [lang, subdomain] = interwiki.split('.');
			return `https://${subdomain}.${domain}/${lang}`;
		}
		return `https://${interwiki}.${domain}`;
	}

	/**
	 * Utility to trim a string to a length
	 * @param {string} text - Input text
	 * @param {number} length - Maximum length
	 * @param {string} [elipsis=…] - Text to use an an elipsis if trimmed
	 * @returns {string} - Trimmed string
	 */
	trimEllip(text, length, elipsis = '…') {
		text = text.trim(); // Remove whitespace padding
		return text.length > length ?
			text.substring(0, length - elipsis.length) + elipsis
			: text;
	}

	/** 
	 * Utility to kind of convert post ADF into plain text (good enough for a preview)
	 * @param {string} adf - ADF JSON
	 * @returns {string} - Plain text
	 */
	adfToText(adf) {
		let plainText = '';

		try {
			let json = JSON.parse(adf);

			for (let paragraph of json.content) {
				if (paragraph.type === 'paragraph') {
					let paragraphText = '';
					for (let content of paragraph.content) {
						if (content.text) {
							paragraphText += content.text;
						}
					}
					if (paragraphText) plainText += paragraphText + '\n';
				}
			}
		} catch (err) { }

		return plainText;
	}

	/**
	 * Initiator
	 */
	async run() {
		await this.fandomLogin();

		this.poll();
		this.interval = setInterval(
			this.poll.bind(this),
			this.config.interval
		);
	}

	/**
	 * Polling function
	 * 
	 * Queries the API for all reported posts and schedules them to be sent if not already sent
	 */
	async poll() {
		try {
			let response = await this.api.get(this.config.fandom.wikiUrl + '/wikia.php', {
				searchParams: {
					controller: 'DiscussionModeration',
					method: 'getReportedPosts',
					format: 'json',
					limit: 100,
					t: Date.now()
				}
			}).json();

			let embeds = [],
				pageIds = new Set([]),
				userIds = new Set([]);

			for (let post of response._embedded['doc:posts']) {
				if (!this.cache.has(post.id)) {
					this.cache.add(post.id);

					// @todo support for anons
					let data = {
						title: post.title,
						body: this.adfToText(post.jsonModel) || post.rawContent,
						image: post._embedded?.contentImages?.[0]?.url,
						timestamp: post.creationDate.epochSecond * 1000,
						author: {
							name: post.createdBy.name,
							id: post.createdBy.id,
							avatar: post.createdBy.avatarUrl
						},
						postId: post.id,
						threadId: post.threadId,
						containerType: post._embedded.thread?.[0]?.containerType,
						containerId: post._embedded.thread?.[0]?.containerId
					}

					if (data.containerType === 'ARTICLE_COMMENT') pageIds.add(data.containerId);
					if (data.containerType === 'WALL') {
						data.wallOwnerId = response._embedded.wallOwners?.find(wall => wall.wallContainerId === data.containerId).userId;
						userIds.add(data.wallOwnerId);
					}
					embeds.push(data);
				}
			}

			// Load article details
			if (pageIds || userIds) this.containerCache = (await this.api.get(this.config.fandom.wikiUrl + '/wikia.php', {
				searchParams: {
					controller: 'FeedsAndPosts',
					method: 'getArticleNamesAndUsernames',
					stablePageIds: Array.from(pageIds).join(','),
					userIds: Array.from(userIds).join(',')
				}
			}).json());

			// Split embeds into chunks of 10 and send them
			if (embeds.length) {
				// Show newest posts last
				embeds = embeds.reverse();
				// Create new arrays of 10 or less items and populate them
				[...Array(Math.ceil(embeds.length / 10))].map((_, i) => embeds.slice(i * 10, i * 10 + 10))
				// Generate and send embeds for each
				.map(list => {
					this.webhook.send({ embeds: list.map(data => this.generateEmbed(data)) });
				})
			};
			this.saveCache();
		} catch (err) {
			if (err.response?.statusCode === 403) this.fandomLogin();
			else console.error(err);
		}
	}

	/**
	 * Generates a Discord embed from collected post data
	 * @param {object} data - Collected post data
	 * @returns {MessageEmbed}
	 */
	generateEmbed(data) {
		// @todo add content type to param
		let embed = new MessageEmbed()
			.setColor(0xE1390B)
			.setURL(this.getPostUrl(data))
			.setAuthor(
				this.trimEllip(data.author.name, 256),
				data.author.avatar,
				`${this.config.fandom.wikiUrl}/wiki/Special:UserProfileActivity/${data.author.name.replaceAll(' ', '_')}`
			)
			.setTimestamp(data.timestamp)
		
		if (data.title) {
			embed.setTitle(this.trimEllip(data.title, 256));
			embed.setDescription(this.trimEllip(data.body, 500));
		} else if (data.body) {
			embed.setTitle(this.trimEllip(data.body, 256));
		} else {
			embed.setTitle('(untitled)');
		}

		if (data.image) embed.setImage(data.image);

		return embed;
	}

	/**
	 * Get the URL to a post based on it's container type
	 * @param {object} data - Collected post data
	 * @param {string[]} articles - article name
	 * @returns {string} - URL to post
	 */
	getPostUrl(data) {
		// @todo don't add reply param for first post
		let base = this.config.fandom.wikiUrl,
			threadId = data.threadId,
			postId = data.postId;

		switch (data.containerType) {
			case 'FORUM':
				return `${base}/f/p/${threadId}/r/${postId}`;
			case 'ARTICLE_COMMENT':
				return `${base}${this.containerCache.articleNames[data.containerId].relativeUrl}?commentId=${threadId}&replyId=${postId}#articleComments`;
			case 'WALL':
				return `${base}/wiki/Message_Wall:${this.containerCache.userIds[data.wallOwnerId].username.replaceAll(' ', '_')}?threadId=${threadId}#${postId}`;
		}
	}

	/**
	 * Cleans up the interval and client
	 * @param {string} [reason] - Reason for exiting
	 */
	finish() {
		console.info('Exiting...');
		if (this.interval) clearInterval(this.interval);
		this.webhook?.destroy();
	}
}

const myBot = new ReportedPostsBot();
myBot.run();