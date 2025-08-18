import fs from 'fs';
import { vi } from 'vitest';
import { DbgpSession } from '../lib/dbgp-session';
import { CDPServer } from '../lib/cdp-server';
import { XdebugCDPBridge } from '../lib/xdebug-cdp-bridge';
import { PHP } from '@php-wasm/universal';
import { RecommendedPHPVersion } from '@wp-playground/common';
import { loadNodeRuntime } from '@php-wasm/node';

describe('XdebugCDPBridge', () => {
	let php: PHP;
	let dbgpSession: DbgpSession;
	let cdpServer: CDPServer;
	let bridge: XdebugCDPBridge;

	beforeEach(async () => {
		php = new PHP(
			await loadNodeRuntime(RecommendedPHPVersion, { withXdebug: true })
		);

		dbgpSession = new DbgpSession();
		cdpServer = new CDPServer();
		bridge = new XdebugCDPBridge(dbgpSession, cdpServer, {
			knownScriptUrls: fs.readdirSync(`${import.meta.dirname}/fixtures`),
			getPHPFile: (file) => php.readFileAsText(file),
		});

		vi.spyOn(dbgpSession, 'sendCommand');
		vi.spyOn(dbgpSession, 'on');
		vi.spyOn(cdpServer, 'sendMessage');
		vi.spyOn(cdpServer, 'on');
	});

	afterEach(() => {
		vi.clearAllMocks();

		bridge.stop();

		php.exit();
	});

	it('ignores files from excluded path', async () => {
		const excludedPath = '/internal/shared';

		const file = `${import.meta.dirname}/fixtures/test.php`;

		const messages: any[] = [];

		const script = fs.readFileSync(file);

		php.writeFile(file, script.toString());

		bridge.start();

		await php.runStream({ scriptPath: file });

		await new Promise<void>((resolve) => {
			const original = cdpServer.sendMessage.bind(cdpServer);
			vi.spyOn(cdpServer, 'sendMessage').mockImplementation((message) => {
				if (message.method === 'Debugger.scriptParsed') {
					messages.push(message);
					resolve();
				}
				return original(message);
			});
		});

		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					params: expect.objectContaining({
						url: expect.stringContaining(excludedPath),
					}),
				}),
			])
		);
		expect(messages).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					params: expect.objectContaining({
						url: expect.stringContaining(file),
					}),
				}),
			])
		);

		bridge.stop();

		php.exit();

		messages.length = 0;

		php = new PHP(
			await loadNodeRuntime(RecommendedPHPVersion, { withXdebug: true })
		);

		dbgpSession = new DbgpSession();
		cdpServer = new CDPServer();
		bridge = new XdebugCDPBridge(dbgpSession, cdpServer, {
			knownScriptUrls: fs.readdirSync(`${import.meta.dirname}/fixtures`),
			getPHPFile: (file) => php.readFileAsText(file),
			excludedPaths: [excludedPath],
		});

		bridge.start();

		await php.runStream({ scriptPath: file });

		await new Promise<void>((resolve) => {
			const original = cdpServer.sendMessage.bind(cdpServer);
			vi.spyOn(cdpServer, 'sendMessage').mockImplementation((message) => {
				if (message.method === 'Debugger.scriptParsed') {
					messages.push(message);
					resolve();
				}
				return original(message);
			});
		});

		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					params: expect.objectContaining({
						url: expect.stringContaining(file),
					}),
				}),
			])
		);
		expect(messages).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					params: expect.objectContaining({
						url: expect.stringContaining(excludedPath),
					}),
				}),
			])
		);
	});
});
