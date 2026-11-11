import { PrivacyGroupWebSocketEvent, WebSocketClientOptions, WebSocketEvent, WebSocketEventCallback } from "./interfaces/websocket";
declare abstract class PaladinWebSocketClientBase<TMessageTypes extends string, TEvent> {
    private options;
    private callback;
    private logger;
    private socket;
    private pingTimer?;
    private disconnectTimer?;
    private reconnectTimer?;
    private disconnectDetected;
    private reconnectAttempts;
    private counter;
    private subscriptionRequests;
    private activeSubscriptions;
    constructor(options: WebSocketClientOptions<TMessageTypes>, callback: WebSocketEventCallback<TEvent>);
    private connect;
    private safeClose;
    getSubscriptionName(subscriptionId: string): string | undefined;
    private clearPingTimers;
    private schedulePing;
    private reconnect;
    send(json: object): void;
    sendRpc(method: string, params: any[]): number;
    close(wait?: boolean): Promise<void>;
    abstract subscribe(type: TMessageTypes, name: string): number;
    abstract ack(subscription: string): void;
    abstract nack(subscription: string): void;
}
export declare class PaladinWebSocketClient extends PaladinWebSocketClientBase<"receipts" | "blockchainevents", WebSocketEvent> {
    subscribe(type: "receipts" | "blockchainevents", name: string): number;
    ack(subscription: string): void;
    nack(subscription: string): void;
}
export declare class PrivacyGroupWebSocketClient extends PaladinWebSocketClientBase<"messages", PrivacyGroupWebSocketEvent> {
    subscribe(type: "messages", name: string): number;
    ack(subscription: string): void;
    nack(subscription: string): void;
}
export {};
