/// <reference path="../../../typings/spawnteract.d.ts" />
import * as child_process from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';
import {Kernel} from './kernel';
import {WSKernel} from './ws-kernel';
import {ZMQKernel} from './zmq-kernel';
import {launchSpec} from 'spawnteract';
import {KernelspecMetadata, Kernelspec} from './contracts';
import {Commands} from '../common/constants';
import {EventEmitter} from 'events';
import {PythonSettings} from '../common/configSettings';
import {formatErrorForLogging} from '../common/utils';

// Todo: Refactor the error handling and displaying of messages

const pythonSettings = PythonSettings.getInstance();

export class KernelManagerImpl extends EventEmitter {
    private _runningKernels: Map<string, Kernel>;
    private _kernelSpecs: { [key: string]: Kernelspec };
    private disposables: vscode.Disposable[];
    constructor(private outputChannel: vscode.OutputChannel) {
        super();
        this.disposables = [];
        this._runningKernels = new Map<string, Kernel>();
        this._kernelSpecs = {};
        this.registerCommands();
    }

    private registerCommands() {
        this.disposables.push(vscode.commands.registerCommand(Commands.Jupyter.Get_All_KernelSpecs_For_Language, this.getAllKernelSpecsFor.bind(this)));
        this.disposables.push(vscode.commands.registerCommand(Commands.Jupyter.StartKernelForKernelSpeck, this.startKernel.bind(this)));
    }
    public dispose() {
        this._runningKernels.forEach(kernel => {
            kernel.dispose();
        });
        this._runningKernels.clear();
    }

    public setRunningKernelFor(language: string, kernel: Kernel) {
        kernel.kernelSpec.language = language;
        this._runningKernels.set(language, kernel);
        this.emit('kernelChanged', kernel, language);
        return kernel;
    }

    public destroyRunningKernelFor(language: string) {
        if (!this._runningKernels.has(language)) {
            return;
        }
        const kernel = this._runningKernels.get(language);
        this._runningKernels.delete(language);
        if (kernel) {
            kernel.dispose();
        }
    }

    public restartRunningKernelFor(language: string): Promise<Kernel> {
        const kernel = this._runningKernels.get(language);
        let startupPromise: Promise<Kernel>;
        if (kernel instanceof WSKernel) {
            startupPromise = new Promise<Kernel>((resolve, reject) => {
                kernel.restart().then(() => {
                    resolve(kernel);
                }, reject.bind(this));
            });
        }
        if (kernel instanceof ZMQKernel && kernel.kernelProcess) {
            const kernelSpec = kernel.kernelSpec;
            this.destroyRunningKernelFor(language);
            startupPromise = this.startKernel(kernelSpec, language);
        }
        if (!startupPromise) {
            vscode.window.showWarningMessage('Cannot restart this kernel');
            startupPromise = Promise.resolve(kernel);
        }

        return startupPromise.catch(reason => {
            let message = 'Failed to start the kernel.';
            if (typeof reason === 'object' && reason.message) {
                message = reason.message;
            }
            vscode.window.showErrorMessage(message);
            this.outputChannel.appendLine(formatErrorForLogging(reason));
            return Promise.reject(reason);
        });
    }

    public startKernelFor(language: string): Promise<Kernel> {
        // We'll display the custom message here
        // Todo: Yes we could create custom error classes, possibly later
        // Then the main class can handle individual errors and display specific messages
        let hasKernelSpec = false;
        return this.getKernelSpecFor(language).then(kernelSpec => {
            hasKernelSpec = true;
            return this.startKernel(kernelSpec, language);
        }).catch(reason => {
            let message = `No kernel for language '${language}' found. Ensure you have a Jupyter or IPython kernel installed for it.`;
            vscode.window.showErrorMessage(message);
            this.outputChannel.appendLine(formatErrorForLogging(reason));
            return;
        });
    }

    public startExistingKernel(language: string, connection, connectionFile): Promise<Kernel> {
        return new Promise<Kernel>(resolve => {
            const kernelSpec = {
                display_name: 'Existing Kernel',
                language: language,
                argv: [],
                env: {}
            };
            const kernel = new ZMQKernel(kernelSpec, language, connection, connectionFile);
            this.setRunningKernelFor(language, kernel);
            return this.executeStartupCode(kernel).then(() => kernel);
        });
    }

    public startKernel(kernelSpec: KernelspecMetadata, language: string): Promise<Kernel> {
        this.destroyRunningKernelFor(language);
        const spawnOptions = {
            cwd: vscode.workspace.rootPath
        };
        return launchSpec(kernelSpec, spawnOptions).then(result => {
            const kernel = new ZMQKernel(kernelSpec, language, result.config, result.connectionFile, result.spawn);
            this.setRunningKernelFor(language, kernel);
            return this.executeStartupCode(kernel).then(() => kernel);
        });
    }

    private executeStartupCode(kernel: Kernel): Promise<any> {
        if (pythonSettings.jupyter.startupCode.length === 0) {
            return Promise.resolve();
        }
        const suffix = ' ' + os.EOL;
        let startupCode = pythonSettings.jupyter.startupCode.join(suffix) + suffix;
        return new Promise<any>((resolve, reject) => {
            let errorMessage = 'Failed to execute kernel startup code. ';
            kernel.execute(startupCode, (result: { type: string, stream: string, message?: string, data: { [key: string]: string } | string }) => {
                if (result.stream === 'status' && result.type === 'text') {
                    if (result.data === 'error') {
                        this.outputChannel.appendLine(errorMessage);
                        vscode.window.showWarningMessage(errorMessage);
                    }
                    return resolve();
                }
                if (result.stream === 'error' && result.type === 'text' && typeof result.message === 'string') {
                    errorMessage += 'Details: ' + result.message;
                }
            });
        });
    }

    public getAllRunningKernels() {
        return this._runningKernels;
    }

    public getRunningKernelFor(language: string) {
        return this._runningKernels.has(language) ? this._runningKernels.get(language) : null;
    }

    public getAllKernelSpecs(): Promise<KernelspecMetadata[]> {
        if (Object.keys(this._kernelSpecs).length === 0) {
            return this.updateKernelSpecs().then(() => {
                return Object.keys(this._kernelSpecs).map(key => this._kernelSpecs[key].spec);
            });
        } else {
            const result = Object.keys(this._kernelSpecs).map(key => this._kernelSpecs[key].spec);
            return Promise.resolve(result);
        }
    }

    public getAllKernelSpecsFor(language: string): Promise<KernelspecMetadata[]> {
        return this.getAllKernelSpecs().then(kernelSpecs => {
            const lowerLang = language.toLowerCase();
            return kernelSpecs.filter(spec => spec.language.toLowerCase() === lowerLang);
        });
    }

    public getKernelSpecFor(language: string): Promise<KernelspecMetadata> {
        return this.getAllKernelSpecsFor(language).then(kernelSpecs => {
            if (kernelSpecs.length === 0) {
                throw new Error('Unable to find a kernel for ' + language);
            }
            if (pythonSettings.jupyter.defaultKernel.length > 0) {
                const defaultKernel = kernelSpecs.find(spec => spec.display_name === pythonSettings.jupyter.defaultKernel);
                if (defaultKernel) {
                    return defaultKernel;
                }
            }
            return kernelSpecs[0];
        });
    }

    public updateKernelSpecs(): Promise<{ [key: string]: Kernelspec }> {
        this._kernelSpecs = {};
        return this.getKernelSpecsFromJupyter().then(kernelSpecsFromJupyter => {
            this._kernelSpecs = kernelSpecsFromJupyter;
            if (Object.keys(this._kernelSpecs).length === 0) {
                throw new Error('No kernel specs found, Update IPython/Jupyter to a version that supports: `jupyter kernelspec list --json` or `ipython kernelspec list --json`');
            } else {
                const message = 'VS Code Kernels updated:';
                const details = Object.keys(this._kernelSpecs).map(key => this._kernelSpecs[key].spec.display_name).join(', ');
                this.outputChannel.appendLine(message + ', ' + details);
            }
            return this._kernelSpecs;
        });
    }

    public getKernelSpecsFromJupyter(): Promise<any> {
        const jupyter = 'jupyter kernelspec list --json --log-level=CRITICAL';
        const ipython = 'ipython kernelspec list --json --log-level=CRITICAL';
        return this.getKernelSpecsFrom(jupyter).catch(jupyterError => {
            return this.getKernelSpecsFrom(ipython);
        });
    }

    public getKernelSpecsFrom(command: string): Promise<any> {
        const options = {
            killSignal: 'SIGINT'
        };
        return new Promise<any>((resolve, reject) => {
            return child_process.exec(command, options, (err, stdout, stderr) => {
                if (err) {
                    return reject(err);
                }
                try {
                    const kernelSpecs = JSON.parse(stdout).kernelspecs;
                    resolve(kernelSpecs);
                } catch (err) {
                    return reject(err);
                }
            });
        });
    }
}