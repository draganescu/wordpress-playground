import type { FileLockManager } from '@php-wasm/node';
import { loadNodeRuntime } from '@php-wasm/node';
import { EmscriptenDownloadMonitor } from '@php-wasm/progress';
import type { RemoteAPI, SupportedPHPVersion } from '@php-wasm/universal';
import {
	PHPWorker,
	consumeAPI,
	consumeAPISync,
	exposeAPI,
	sandboxedSpawnHandlerFactory,
} from '@php-wasm/universal';
import { sprintf } from '@php-wasm/util';
import { RecommendedPHPVersion } from '@wp-playground/common';
import { bootWordPress, bootRequestHandler } from '@wp-playground/wordpress';
import { rootCertificates } from 'tls';
import { jspi } from 'wasm-feature-detect';
import { MessageChannel, type MessagePort, parentPort } from 'worker_threads';
import { mountResources } from '../mounts';

export interface Mount {
	hostPath: string;
	vfsPath: string;
}

export type WorkerBootOptions = {
	php: SupportedPHPVersion;
	siteUrl: string;
	mountsBeforeWpInstall: Array<Mount>;
	mountsAfterWpInstall: Array<Mount>;
	firstProcessId: number;
	processIdSpaceLength: number;
	followSymlinks: boolean;
	trace: boolean;
	/**
	 * When true, Playground will not send cookies to the client but will manage
	 * them internally. This can be useful in environments that can't store cookies,
	 * e.g. VS Code WebView.
	 *
	 * Default: false.
	 */
	internalCookieStore?: boolean;
	withXdebug?: boolean;
	nativeInternalDirPath: string;
};

export type PrimaryWorkerBootOptions = WorkerBootOptions & {
	wpVersion?: string;
	wordPressZip?: ArrayBuffer;
	sqliteIntegrationPluginZip?: ArrayBuffer;
	dataSqlPath?: string;
};

interface WorkerBootRequestHandlerOptions {
	siteUrl: string;
	allow?: string;
	php: SupportedPHPVersion;
	firstProcessId: number;
	processIdSpaceLength: number;
	trace: boolean;
	nativeInternalDirPath: string;
}

/**
 * Print trace messages from PHP-WASM.
 *
 * @param {number} processId - The process ID.
 * @param {string} format - The format string.
 * @param {...any} args - The arguments.
 */
function tracePhpWasm(processId: number, format: string, ...args: any[]) {
	// eslint-disable-next-line no-console
	console.log(
		performance.now().toFixed(6).padStart(15, '0'),
		processId.toString().padStart(16, '0'),
		sprintf(format, ...args)
	);
}

export class PlaygroundCliBlueprintV1Worker extends PHPWorker {
	booted = false;
	fileLockManager: RemoteAPI<FileLockManager> | FileLockManager | undefined;

	constructor(monitor: EmscriptenDownloadMonitor) {
		super(undefined, monitor);
	}

	/**
	 * Call this method before boot() to use file locking.
	 *
	 * This method is separate from boot() to simplify the related Comlink.transferHandlers
	 * setup – if an argument is a MessagePort, we're transferring it, not copying it.
	 *
	 * @see comlink-sync.ts
	 * @see phpwasm-emscripten-library-file-locking-for-node.js
	 */
	async useFileLockManager(port: MessagePort) {
		if (await jspi()) {
			/**
			 * If JSPI is available, php.js supports both synchronous and asynchronous locking syscalls.
			 * Web browsers, however, only support asynchronous message passing so let's use the
			 * asynchronous API. Every method call will return a promise.
			 *
			 * @see comlink-sync.ts
			 * @see phpwasm-emscripten-library-file-locking-for-node.js
			 */
			this.fileLockManager = consumeAPI<FileLockManager>(port);
		} else {
			/**
			 * If JSPI is not available, php.js only supports synchronous locking syscalls.
			 * Let's use the synchronous API. Every method call will block this thread
			 * until the result is available.
			 *
			 * @see comlink-sync.ts
			 * @see phpwasm-emscripten-library-file-locking-for-node.js
			 */
			this.fileLockManager = await consumeAPISync<FileLockManager>(port);
		}
	}

	async bootAsPrimaryWorker({
		siteUrl,
		mountsBeforeWpInstall,
		mountsAfterWpInstall,
		php = RecommendedPHPVersion,
		wordPressZip,
		sqliteIntegrationPluginZip,
		firstProcessId,
		processIdSpaceLength,
		dataSqlPath,
		followSymlinks,
		trace,
		internalCookieStore,
		withXdebug,
		nativeInternalDirPath,
	}: PrimaryWorkerBootOptions) {
		if (this.booted) {
			throw new Error('Playground already booted');
		}
		this.booted = true;

		let nextProcessId = firstProcessId;
		const lastProcessId = firstProcessId + processIdSpaceLength - 1;

		try {
			const constants: Record<string, string | number | boolean | null> =
				{
					WP_DEBUG: true,
					WP_DEBUG_LOG: true,
					WP_DEBUG_DISPLAY: false,
				};

			const requestHandler = await bootWordPress({
				siteUrl,
				createPhpRuntime: async (isPrimary) => {
					const processId = nextProcessId;

					if (nextProcessId < lastProcessId) {
						nextProcessId++;
					} else {
						// We've reached the end of the process ID space. Start over.
						nextProcessId = firstProcessId;
					}

					return await loadNodeRuntime(php, {
						emscriptenOptions: {
							fileLockManager: this.fileLockManager!,
							processId,
							trace: trace ? tracePhpWasm : undefined,
							phpWasmInitOptions: isPrimary
								? // Only pass a native /internal dir to the primary PHP process
								  // because the secondary PHP process will proxy to it.
								  {
										nativeInternalDirPath,
								  }
								: {},
						},
						followSymlinks,
						withXdebug,
					});
				},
				wordPressZip:
					wordPressZip !== undefined
						? new File([wordPressZip], 'wordpress.zip')
						: undefined,
				sqliteIntegrationPluginZip:
					sqliteIntegrationPluginZip !== undefined
						? new File(
								[sqliteIntegrationPluginZip],
								'sqlite-integration-plugin.zip'
						  )
						: undefined,
				sapiName: 'cli',
				createFiles: {
					'/internal/shared/ca-bundle.crt':
						rootCertificates.join('\n'),
				},
				constants,
				phpIniEntries: {
					'openssl.cafile': '/internal/shared/ca-bundle.crt',
					allow_url_fopen: '1',
					disable_functions: '',
				},
				hooks: {
					async beforeWordPressFiles(php) {
						mountResources(php, mountsBeforeWpInstall);
					},
				},
				cookieStore: internalCookieStore ? undefined : false,
				dataSqlPath,
				spawnHandler: sandboxedSpawnHandlerFactory,
			});
			this.__internal_setRequestHandler(requestHandler);

			const primaryPhp = await requestHandler.getPrimaryPhp();
			await this.setPrimaryPHP(primaryPhp);

			mountResources(primaryPhp, mountsAfterWpInstall);

			setApiReady();
		} catch (e) {
			setAPIError(e as Error);
			throw e;
		}
	}

	async bootAsSecondaryWorker(args: WorkerBootOptions) {
		await this.bootRequestHandler(args);
		const primaryPhp = this.__internal_getPHP()!;
		// When secondary workers are spawned, WordPress is already installed.
		await mountResources(primaryPhp, args.mountsBeforeWpInstall || []);
		await mountResources(primaryPhp, args.mountsAfterWpInstall || []);
	}

	async bootRequestHandler({
		siteUrl,
		allow,
		php,
		firstProcessId,
		processIdSpaceLength,
		trace,
		nativeInternalDirPath,
	}: WorkerBootRequestHandlerOptions) {
		if (this.booted) {
			throw new Error('Playground already booted');
		}
		this.booted = true;

		let nextProcessId = firstProcessId;
		const lastProcessId = firstProcessId + processIdSpaceLength - 1;

		try {
			const requestHandler = await bootRequestHandler({
				siteUrl,
				createPhpRuntime: async () => {
					const processId = nextProcessId;

					if (nextProcessId < lastProcessId) {
						nextProcessId++;
					} else {
						// We've reached the end of the process ID space. Start over.
						nextProcessId = firstProcessId;
					}

					return await loadNodeRuntime(php!, {
						emscriptenOptions: {
							fileLockManager: this.fileLockManager!,
							processId,
							trace: trace ? tracePhpWasm : undefined,
							ENV: {
								DOCROOT: '/wordpress',
							},
							phpWasmInitOptions: {
								nativeInternalDirPath,
							},
						},
						followSymlinks: allow?.includes('follow-symlinks'),
					});
				},
				sapiName: 'cli',
				cookieStore: false,
				spawnHandler: sandboxedSpawnHandlerFactory,
			});
			this.__internal_setRequestHandler(requestHandler);

			const primaryPhp = await requestHandler.getPrimaryPhp();
			await this.setPrimaryPHP(primaryPhp);

			setApiReady();
		} catch (e) {
			setAPIError(e as Error);
			throw e;
		}
	}

	// Provide a named disposal method that can be invoked via comlink.
	async dispose() {
		await this[Symbol.asyncDispose]();
	}
}

const phpChannel = new MessageChannel();

const [setApiReady, setAPIError] = exposeAPI(
	new PlaygroundCliBlueprintV1Worker(new EmscriptenDownloadMonitor()),
	undefined,
	phpChannel.port1
);

parentPort!.postMessage(
	{
		command: 'worker-script-initialized',
		phpPort: phpChannel.port2,
	},
	[phpChannel.port2 as any]
);
