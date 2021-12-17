import fs from 'fs/promises'
import process from 'process'
import got from 'got'
import { CookieJar } from 'tough-cookie'
import { WebhookClient, MessageEmbed } from 'discord.js'

import { createRequire } from "module";
const require = createRequire(import.meta.url);

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
			webhook: {
				id: process.env.WEBHOOK_ID,
				token: process.env.WEBHOOK_TOKEN
			},
			fandom: {
				wiki: process.env.FANDOM_WIKI,
				domain: process.env.FANDOM_DOMAIN || 'fandom.com',
				username: process.env.FANDOM_USERNAME,
				password: process.env.FANDOM_PASSWORD
			},
			interval: (process.env.INTERVAL || 60) * 1000
		};

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
		try {
			this.cache = new Set(require('./cache.json'));
			console.info('Loaded cache')
		} catch (err) {
			console.log(err)
			this.cache = new Set();
			console.info('No cache found')
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
		fs.writeFile('cache.json', JSON.stringify(Array.from(this.cache)), () => {});
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
		text = text.trim(); // Remove whitespace
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
					embeds.push(data)
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

			if (embeds.length) this.webhook.send({ embeds: embeds.reverse().map(data => this.generateEmbed(data)) });
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
		let embed = new MessageEmbed()
			.setColor(0xE1390B)
			.setURL(this.getPostUrl(data))
			.setAuthor(
				this.trimEllip(data.author.name, 256),
				data.author.avatar,
				// @todo use user page or Special:UserProfileActivity instead
				`${this.config.fandom.wikiUrl}/f/u/${data.author.id}`
			)
			.setTimestamp(data.timestamp)
		
		if (data.title) {
			embed.setTitle(this.trimEllip(data.title, 256));
			embed.setDescription(this.trimEllip(data.body), 500);
		} else if (data.body) {
			embed.setTitle(this.trimEllip(data.body), 256);
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
				return `${base}/wiki/Message_Wall:${this.containerCache.userIds[data.wallOwnerId].username}?threadId=${threadId}#${postId}`;
		}
	}
}

const myBot = new ReportedPostsBot();
myBot.run();