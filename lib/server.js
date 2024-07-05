'use strict';


const fastify = require('fastify');
const fp = require('fastify-plugin');
const glob = require('fast-glob');
const fastifySensible = require('@fastify/sensible');
const fastifyAccepts = require('@fastify/accepts');
const fastifyCookie = require('@fastify/cookie');
const fastifyCors = require('@fastify/cors');
const fastifyEtag = require('@fastify/etag');
const fastifyRequestContext = require('@fastify/request-context');
const path = require('path');
const uuid = require('uuid');
const addErrors = require('ajv-errors');
const addFormats = require('ajv-formats');
const addKeywords = require('ajv-keywords');
const logger = require('./logger');

exports.bootstrap = async function () {
	let override = {};
	let customerServer;
	const custom = glob.sync(path.resolve(process.cwd(), './server.*'));
	if (custom) {
		const server = await import(custom[0]);
		if (server.config) {
			override = server.config;
		}
		if (server) {
			const handle = server.instance || server.default || server;
			if (handle) {
				if (handle[Symbol.toStringTag] === 'AsyncFunction') {
					customerServer = handle;
				} else {
					logger.error('SERVER: Custom server must be an async function');
				}
			}
		}
	}

	const instance = fastify({
		logger,
		disableRequestLogging: true,
		ignoreTrailingSlash: true,
		trustProxy: true,
		pluginTimeout: 0,
		maxParamLength: 100,
		...override,
		ajv: {
			customOptions: {
				strictSchema: false,
				allErrors: true,
				allowUnionTypes: true,
				coerceTypes: true,
				useDefaults: true,
				...override?.ajv?.customOptions,
			},
			plugins: [
				addFormats,
				addErrors,
				[addKeywords, 'transform']
			]
		},
		genReqId: () => uuid.v1(),
	});

	instance.register(fastifyRequestContext);
	instance.register(fastifyCors, {origin: true, credentials: 'include'});
	instance.register(fastifyCookie);
	instance.register(fastifyAccepts);
	instance.register(fastifySensible);
	instance.register(fastifyEtag);

	instance.addHook('onRequest', async (request) => {
		const {id, url, ip} = request;
		const useragent = request.headers['user-agent'];
		request.requestContext.set('request', {id, url, ip, useragent});
	});

	// instance.register(session.middleware());
	// instance.register(csrf.middleware());
	// instance.register(rateLimit.middleware());
	// instance.register(idempotency.middleware());
	// instance.register(openapi.middleware());
	// instance.register(error.middleware());
	// instance.register(reply.middleware());

	if (customerServer) {
		instance.log.info('Custom server registered');
		instance.register(customerServer);
	}

	instance.setNotFoundHandler((request, reply) => {
		reply.error(new Error('This API route does not exist or have been moved. Please check with the documentation for the desired API endpoint.'), 404);
	});

	instance.setErrorHandler((error, request, reply) => {
		request.log.error(error);
		return reply.error(error);
	});

	instance.register(routeLoader);
	// instance.register(cloudsql.middleware());

    return instance;
}

async function routeLoader(instance) {
	// TODO: apply middleware only on specific folder hierarchy, don't duplicate require
	//  1. if middleware exists above the handler, create wrapper
	//  2. get all routes that are below the middleware
	//  3. register the middleware, then register all routes below it
	//  4. if middleware doesn't exist, register all routes in the same level
	return fp(async (_instance) => {
		glob.sync([
			path.resolve(process.cwd(), 'api/**/index.*'),
		], {ignore: ['**/*.spec.*']}).forEach((handler) => {
			_instance.register(async (wrapper) => {
				const up = ['../'];
				const middlewares = [];
				// eslint-disable-next-line no-constant-condition
				while (true) {
					const basename = path.basename(path.resolve(handler, up.join('')));
					const [middleware] = glob.sync([path.resolve(path.dirname(handler), up.join(''), 'middleware.*')]);
					if (middleware) {
						if (fs.existsSync(middleware)) {
							const handler = await import(middleware);
							const handle = handler.default || handler;
							if (handle) {
								if (handle[Symbol.toStringTag] === 'AsyncFunction') {
									middlewares.push(fp(handle));
								}
							}
						}
						if (basename === 'handlers') break;
						up.push('../');
					} else {
						break;
					}
				}
				middlewares.reverse().map((middleware) => wrapper.register(middleware));
				const route = await import(handler);
				const handle = route.default || route;
				if (handle) {
					if (['AsyncFunction', 'Function'].includes(handle[Symbol.toStringTag])) {
						// logger.info('[ROUTE] Registered Route: %s', path.dirname(handler));
						const schema = {};
						const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
						wrapper.register(async function (_instance) {
							methods.forEach((method) => {
								const originalMethod = _instance[method];
								_instance[method] = function (...args) {
									const url = args[0];
									let options = {};
									let route;
									if (typeof args[1] === 'object') {
										options = args[1];
										route = args[2];
									} else if (typeof args[1] === 'function') {
										route = args[1];
									}
									if (fs.existsSync(path.resolve(path.dirname(handler), 'schema.json'))) {
										try {
											const override = options.schema ?? {};
											options.schema = {...override, ...JSON.parse(fs.readFileSync(path.resolve(path.dirname(handler), 'schema.json')))};
										} catch {
											// noop
										}
									}
									if (options.schema) {
										schema[`${method}${url}`] = options.schema;
									}
									return originalMethod.call(_instance, ...[url, options, route]);
								};
							});
							await handle(_instance);
							// do something schema;
						});
					}
				}
			});
		});
	});
}
