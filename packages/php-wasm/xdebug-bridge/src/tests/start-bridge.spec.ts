import { EventEmitter } from 'events';
import { startBridge } from '../lib/start-bridge';
import { XdebugCDPBridge } from '../lib/xdebug-cdp-bridge';

describe('Bridge', () => {
	beforeEach(async () => {
		vi.spyOn(global, 'setTimeout').mockImplementation(
			(cb) => global.setImmediate(() => cb()) as unknown as NodeJS.Timeout
		);
		vi.spyOn(EventEmitter.prototype, 'on').mockImplementation(function (
			this: EventEmitter,
			event,
			cb
		) {
			if (event === 'clientConnected') {
				setTimeout(cb, 0);
			}
			return this;
		});

		vi.spyOn(
			await import('../lib/cdp-server'),
			'CDPServer'
		).mockReturnThis();
		vi.spyOn(
			await import('../lib/dbgp-session'),
			'DbgpSession'
		).mockReturnThis();
		vi.spyOn(
			await import('../lib/xdebug-cdp-bridge'),
			'XdebugCDPBridge'
		).mockReturnThis();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('excludes given paths', async () => {
		const paths = ['/foo', '/bar'];

		await startBridge({ excludedPaths: paths });

		const args = (XdebugCDPBridge as any).mock.calls[0][2];

		expect(args.excludedPaths).toEqual(paths);
	});
});
