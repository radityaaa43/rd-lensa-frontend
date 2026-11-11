"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrivacyGroupWebSocketClient = exports.PaladinWebSocketClient = void 0;
const stream_1 = require("stream");
const ws_1 = __importDefault(require("ws"));
class PaladinWebSocketClientBase {
    constructor(options, callback) {
        this.options = options;
        this.callback = callback;
        this.disconnectDetected = false;
        this.reconnectAttempts = 0;
        this.counter = 1;
        this.subscriptionRequests = new Map(); // request ID -> subscription name
        this.activeSubscriptions = new Map(); // subscription ID -> subscription name
        this.logger = options.logger ?? console;
        this.connect();
    }
    connect() {
        // Clean up any old socket completely
        if (this.socket) {
            this.safeClose(this.socket);
            this.socket = undefined;
        }
        // Clear any pending reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        const auth = this.options.username && this.options.password
            ? `${this.options.username}:${this.options.password}`
            : undefined;
        const socket = (this.socket = new ws_1.default(this.options.url, {
            ...this.options.socketOptions,
            auth,
            handshakeTimeout: this.options.heartbeatInterval,
        }));
        socket
            .on("open", () => {
            this.reconnectAttempts = 0;
            if (this.disconnectDetected) {
                this.disconnectDetected = false;
                this.logger.log("Connection restored");
            }
            else {
                this.logger.log("Connected");
            }
            this.schedulePing();
            this.subscriptionRequests.clear();
            this.activeSubscriptions.clear();
            for (const sub of this.options.subscriptions ?? []) {
                // Automatically connect subscriptions
                const id = this.subscribe(sub.type, sub.name);
                this.subscriptionRequests.set(id, sub.name);
                this.logger.log(`Requested to start listening on subscription ${sub.name}`);
            }
            if (this.options?.afterConnect !== undefined) {
                this.options.afterConnect(this);
            }
        })
            .on("error", (err) => {
            this.logger.error("Error", err.stack);
        })
            .on("close", () => {
            // Note: this is always an unexpected close (direct calls will remove the listeners first)
            this.disconnectDetected = true;
            this.reconnect("Closed by peer");
        })
            .on("pong", () => {
            this.logger.debug && this.logger.debug(`WS received pong`);
            this.schedulePing();
        })
            .on("unexpected-response", (req, res) => {
            let responseData = "";
            res.pipe(new stream_1.Transform({
                transform(chunk, encoding, callback) {
                    responseData += chunk;
                    callback();
                },
                flush: () => {
                    this.reconnect(`Websocket connect error [${res.statusCode}]: ${responseData}`);
                },
            }));
        })
            .on("message", (data) => {
            const event = JSON.parse(data.toString());
            if (typeof event === "object" && event !== null && "result" in event) {
                // Result of a previously sent RPC - check if it's a subscription request
                const subName = this.subscriptionRequests.get(event.id);
                if (subName) {
                    const subId = event.result;
                    this.logger.log(`Subscription ${subName} assigned ID: ${subId}`);
                    this.subscriptionRequests.delete(event.id);
                    this.activeSubscriptions.set(subId, subName);
                }
            }
            else {
                // Any other event - pass to the callback
                this.callback(this, event);
            }
        });
    }
    safeClose(socket) {
        socket.removeAllListeners();
        // Re-attach a no-op error listener to squash any async errors emitted by close()
        // (otherwise they would be uncaught and crash the process)
        socket.on("error", () => { });
        try {
            socket.close();
        }
        catch (e) {
            this.logger.warn(`Failed to close socket: ${e.message}`);
        }
    }
    getSubscriptionName(subscriptionId) {
        return this.activeSubscriptions.get(subscriptionId);
    }
    clearPingTimers() {
        if (this.disconnectTimer) {
            clearTimeout(this.disconnectTimer);
            delete this.disconnectTimer;
        }
        if (this.pingTimer) {
            clearTimeout(this.pingTimer);
            delete this.pingTimer;
        }
    }
    schedulePing() {
        this.clearPingTimers();
        const heartbeatInterval = this.options.heartbeatInterval ?? 30000;
        this.disconnectTimer = setTimeout(() => this.reconnect("Heartbeat timeout"), Math.ceil(heartbeatInterval * 1.5) // 50% grace period
        );
        this.pingTimer = setTimeout(() => {
            if (this.socket?.readyState !== ws_1.default.OPEN) {
                return;
            }
            this.logger.debug && this.logger.debug(`WS sending ping`);
            this.socket.ping("ping", true, (err) => {
                if (err)
                    this.reconnect(err.message);
            });
        }, heartbeatInterval);
    }
    reconnect(msg) {
        this.clearPingTimers();
        if (this.reconnectTimer) {
            // Reconnect already scheduled
            return;
        }
        this.logger.error(`Websocket closed: ${msg}`);
        if (this.options.reconnectDelay === -1) {
            // Reconnection disabled - just clean up
            if (this.socket) {
                this.safeClose(this.socket);
                this.socket = undefined;
            }
            return;
        }
        // Compute reconnect delay
        const baseDelay = this.options.reconnectDelay ?? 2000;
        const maxDelay = this.options.reconnectBackoffMaxDelay;
        const delay = maxDelay !== undefined
            ? Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay)
            : baseDelay;
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
    send(json) {
        if (this.socket !== undefined) {
            this.socket.send(JSON.stringify(json));
        }
    }
    sendRpc(method, params) {
        const id = this.counter++;
        this.send({
            jsonrpc: "2.0",
            id,
            method,
            params,
        });
        return id;
    }
    async close(wait) {
        this.clearPingTimers();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (!this.socket) {
            return;
        }
        const socket = this.socket;
        this.socket = undefined;
        if (wait) {
            // Add a one-time listener just for this close
            socket.removeAllListeners();
            socket.on("error", () => { });
            return new Promise((resolve) => {
                socket.once("close", () => {
                    this.logger.log("Closed");
                    resolve();
                });
                try {
                    socket.close();
                }
                catch (e) {
                    this.logger.warn(`Failed to close websocket: ${e.message}`);
                    resolve();
                }
            });
        }
        else {
            // Clean up any old socket completely (including all listeners)
            this.safeClose(socket);
        }
    }
}
class PaladinWebSocketClient extends PaladinWebSocketClientBase {
    subscribe(type, name) {
        return this.sendRpc("ptx_subscribe", [type, name]);
    }
    ack(subscription) {
        this.sendRpc("ptx_ack", [subscription]);
    }
    nack(subscription) {
        this.sendRpc("ptx_nack", [subscription]);
    }
}
exports.PaladinWebSocketClient = PaladinWebSocketClient;
class PrivacyGroupWebSocketClient extends PaladinWebSocketClientBase {
    subscribe(type, name) {
        return this.sendRpc("pgroup_subscribe", [type, name]);
    }
    ack(subscription) {
        this.sendRpc("pgroup_ack", [subscription]);
    }
    nack(subscription) {
        this.sendRpc("pgroup_nack", [subscription]);
    }
}
exports.PrivacyGroupWebSocketClient = PrivacyGroupWebSocketClient;
