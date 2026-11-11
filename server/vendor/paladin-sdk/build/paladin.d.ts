import { AxiosInstance } from "axios";
import { ethers, InterfaceAbi } from "ethers";
import { ActiveFilter, Algorithms, DomainInvokeRPC, IBlockchainEventListener, IDomain, IDomainSmartContract, IPrivacyGroupEVMCall, IPrivacyGroupEVMTXInput, IPrivacyGroupInput, IPrivacyGroupMessageInput, IPrivacyGroupMessageListener, IQuery, ITransactionCall, ITransactionInput, ITransactionReceiptListener, PaladinConfig, StateStatus, Verifiers } from "./interfaces";
import { PaladinVerifier } from "./verifier";
export default class PaladinClient {
    protected http: AxiosInstance;
    private logger;
    private onError;
    constructor(options: PaladinConfig);
    getHttpInstance(): AxiosInstance;
    protected defaultHeaders(): {
        Accept: string;
        "Content-Type": string;
    };
    protected defaultPayload(): {
        jsonrpc: string;
        id: number;
    };
    getVerifiers(...lookups: string[]): PaladinVerifier[];
    parseAxiosErrorMessage(err: any): any;
    private post;
    pollForReceipt(txID: string, waitMs: number, full?: boolean): Promise<any>;
    pollForPreparedTransaction(txID: string, waitMs: number): Promise<any>;
    /**
     * @deprecated Use ptx.prepareTransaction instead
     */
    prepareTransaction(transaction: ITransactionInput): Promise<any>;
    /**
     * @deprecated Use ptx.sendTransaction instead
     */
    sendTransaction(transaction: ITransactionInput): Promise<any>;
    /**
     * @deprecated Use ptx.call instead
     */
    call(transaction: ITransactionCall): Promise<any>;
    /**
     * @deprecated Use ptx.queryTransactions instead
     */
    queryTransactions(query: IQuery): Promise<any>;
    /**
     * @deprecated Use ptx.getTransaction or ptx.getTransactionFull instead
     */
    getTransaction(txID: string, full?: boolean): Promise<any>;
    /**
     * @deprecated Use ptx.getPreparedTransaction instead
     */
    getPreparedTransaction(txID: string): Promise<any>;
    /**
     * @deprecated Use ptx.queryTransactionReceipts instead
     */
    queryTransactionReceipts(query: IQuery): Promise<any>;
    /**
     * @deprecated Use ptx.getTransactionReceipt or ptx.getTransactionReceiptFull instead
     */
    getTransactionReceipt(txID: string, full?: boolean): Promise<any>;
    /**
     * @deprecated Use ptx.getStateReceipt instead
     */
    getStateReceipt(txID: string): Promise<any>;
    /**
     * @deprecated Use ptx.getDomainReceipt instead
     */
    getDomainReceipt(domain: string, txID: string): Promise<any>;
    /**
     * @deprecated Use ptx.resolveVerifier instead
     */
    resolveVerifier(lookup: string, algorithm: Algorithms | string, verifierType: Verifiers | string): Promise<any>;
    /**
     * @deprecated Use ptx.storeABI instead
     */
    storeABI(abi: ethers.InterfaceAbi): Promise<void>;
    /**
     * @deprecated Use ptx.getStoredABI instead
     */
    getStoredABI(hash: string): Promise<any>;
    /**
     * @deprecated Use ptx.decodeCall instead
     */
    decodeCall(callData: string, dataFormat: string): Promise<any>;
    /**
     * @deprecated Use ptx.decodeEvent instead
     */
    decodeEvent(topics: string[], data: string): Promise<any>;
    /**
     * @deprecated Use ptx.decodeError instead
     */
    decodeError(revertError: string, dataFormat: string): Promise<any>;
    /**
     * @deprecated Use bidx.decodeTransactionEvents instead
     */
    decodeTransactionEvents(transactionHash: string, abi: InterfaceAbi, resultFormat: string): Promise<any>;
    /**
     * @deprecated Use pstate.listSchemas instead
     */
    listSchemas(domain: string): Promise<any>;
    /**
     * @deprecated Use pstate.queryStates instead
     */
    queryStates(domain: string, schema: string, query: IQuery, status: StateStatus): Promise<any>;
    /**
     * @deprecated Use pstate.queryContractStates instead
     */
    queryContractStates(domain: string, contractAddress: string, schema: string, query: IQuery, status: StateStatus): Promise<any>;
    /**
     * @deprecated Use pgroup.createGroup instead
     */
    createPrivacyGroup(pgroup: IPrivacyGroupInput): Promise<any>;
    /**
     * @deprecated Use pgroup.getGroupById instead
     */
    getPrivacyGroupById(domainName: string, id: string): Promise<any>;
    /**
     * @deprecated Use pgroup.getGroupByAddress instead
     */
    getPrivacyGroupByAddress(address: string): Promise<any>;
    /**
     * @deprecated Use pgroup.sendTransaction instead
     */
    sendPrivacyGroupTransaction(txi: IPrivacyGroupEVMTXInput): Promise<any>;
    /**
     * @deprecated Use pgroup.call instead
     */
    callPrivacyGroup(txi: IPrivacyGroupEVMCall): Promise<any>;
    /**
     * @deprecated Use ptx.createReceiptListener instead
     */
    createReceiptListener(listener: ITransactionReceiptListener): Promise<any>;
    /**
     * @deprecated Use ptx.deleteReceiptListener instead
     */
    deleteReceiptListener(name: string): Promise<any>;
    /**
     * @deprecated Use ptx.getReceiptListener instead
     */
    getReceiptListener(name: string): Promise<any>;
    /**
     * @deprecated Use ptx.createBlockchainEventListener instead
     */
    createBlockchainEventListener(listener: IBlockchainEventListener): Promise<any>;
    /**
     * @deprecated Use ptx.deleteBlockchainEventListener instead
     */
    deleteBlockchainEventListener(name: string): Promise<any>;
    /**
     * @deprecated Use ptx.getBlockchainEventListener instead
     */
    getBlockchainEventListener(name: string): Promise<any>;
    keymgr: {
        wallets: () => Promise<any>;
        resolveKey: (identifier: string, algorithm: string, verifierType: string) => Promise<any>;
        resolveEthAddress: (identifier: string) => Promise<any>;
        reverseKeyLookup: (algorithm: string, verifierType: string, verifier: string) => Promise<any>;
        queryKeys: (query: IQuery) => Promise<any>;
        sign: (keyIdentifier: string, algorithm: string, verifierType: string, payloadType: string, payload: string) => Promise<any>;
    };
    ptx: {
        sendTransaction: (transaction: ITransactionInput) => Promise<any>;
        sendTransactions: (transactions: ITransactionInput[]) => Promise<any>;
        prepareTransaction: (transaction: ITransactionInput) => Promise<any>;
        prepareTransactions: (transactions: ITransactionInput[]) => Promise<any>;
        updateTransaction: (id: string, transaction: ITransactionInput) => Promise<any>;
        call: (transaction: ITransactionCall) => Promise<any>;
        getTransaction: (txID: string) => Promise<any>;
        getTransactionFull: (txID: string) => Promise<any>;
        getTransactionByIdempotencyKey: (idempotencyKey: string) => Promise<any>;
        queryTransactions: (query: IQuery) => Promise<any>;
        queryTransactionsFull: (query: IQuery) => Promise<any>;
        queryPendingTransactions: (query: IQuery, full?: boolean) => Promise<any>;
        getTransactionReceipt: (txID: string) => Promise<any>;
        getTransactionReceiptFull: (txID: string) => Promise<any>;
        getDomainReceipt: (domain: string, txID: string) => Promise<any>;
        getStateReceipt: (txID: string) => Promise<any>;
        queryTransactionReceipts: (query: IQuery) => Promise<any>;
        getTransactionDependencies: (txID: string) => Promise<any>;
        queryPublicTransactions: (query: IQuery) => Promise<any>;
        queryPendingPublicTransactions: (query: IQuery) => Promise<any>;
        getPublicTransactionByNonce: (from: string, nonce: number) => Promise<any>;
        getPublicTransactionByHash: (hash: string) => Promise<any>;
        getPreparedTransaction: (txID: string) => Promise<any>;
        queryPreparedTransactions: (query: IQuery) => Promise<any>;
        storeABI: (abi: ethers.InterfaceAbi) => Promise<void>;
        getStoredABI: (hash: string) => Promise<any>;
        queryStoredABIs: (query: IQuery) => Promise<any>;
        decodeCall: (callData: string, dataFormat: string) => Promise<any>;
        decodeEvent: (topics: string[], data: string) => Promise<any>;
        decodeError: (revertError: string, dataFormat: string) => Promise<any>;
        resolveVerifier: (lookup: string, algorithm: Algorithms | string, verifierType: Verifiers | string) => Promise<any>;
        createReceiptListener: (listener: ITransactionReceiptListener) => Promise<any>;
        queryReceiptListeners: (query: IQuery) => Promise<any>;
        getReceiptListener: (name: string) => Promise<any>;
        startReceiptListener: (name: string) => Promise<any>;
        stopReceiptListener: (name: string) => Promise<any>;
        deleteReceiptListener: (name: string) => Promise<any>;
        createBlockchainEventListener: (listener: IBlockchainEventListener) => Promise<any>;
        queryBlockchainEventListeners: (query: IQuery) => Promise<any>;
        getBlockchainEventListener: (name: string) => Promise<any>;
        startBlockchainEventListener: (name: string) => Promise<any>;
        stopBlockchainEventListener: (name: string) => Promise<any>;
        deleteBlockchainEventListener: (name: string) => Promise<any>;
        getBlockchainEventListenerStatus: (name: string) => Promise<any>;
    };
    pstate: {
        listSchemas: (domain: string) => Promise<any>;
        getSchemaById: (domain: string, schemaId: string) => Promise<any>;
        storeState: (domain: string, contractAddress: string, schema: string, data: any) => Promise<any>;
        queryStates: (domain: string, schema: string, query: IQuery, status: StateStatus) => Promise<any>;
        queryContractStates: (domain: string, contractAddress: string, schema: string, query: IQuery, status: StateStatus) => Promise<any>;
        queryNullifiers: (domain: string, schema: string, query: IQuery, status: StateStatus) => Promise<any>;
        queryContractNullifiers: (domain: string, contractAddress: string, schema: string, query: IQuery, status: StateStatus) => Promise<any>;
    };
    pgroup: {
        createGroup: (pgroup: IPrivacyGroupInput) => Promise<any>;
        getGroupById: (domainName: string, id: string) => Promise<any>;
        getGroupByAddress: (address: string) => Promise<any>;
        queryGroups: (query: IQuery) => Promise<any>;
        queryGroupsWithMember: (member: string, query: IQuery) => Promise<any>;
        sendTransaction: (txi: IPrivacyGroupEVMTXInput) => Promise<any>;
        call: (txi: IPrivacyGroupEVMCall) => Promise<any>;
        sendMessage: (msg: IPrivacyGroupMessageInput) => Promise<any>;
        getMessageById: (id: string) => Promise<any>;
        queryMessages: (query: IQuery) => Promise<any>;
        createMessageListener: (listener: IPrivacyGroupMessageListener) => Promise<any>;
        queryMessageListeners: (query: IQuery) => Promise<any>;
        getMessageListener: (name: string) => Promise<any>;
        startMessageListener: (name: string) => Promise<any>;
        stopMessageListener: (name: string) => Promise<any>;
        deleteMessageListener: (name: string) => Promise<any>;
        invokeRPC: (domainName: string, groupID: string, stateQualifier: string, rpcCall: DomainInvokeRPC) => Promise<any>;
    };
    transport: {
        nodeName: () => Promise<any>;
        localTransports: () => Promise<any>;
        localTransportDetails: (transportName: string) => Promise<any>;
        /**
         * @deprecated Use transport.queryPeers instead
         */
        peers: () => Promise<any>;
        queryPeers: (query: IQuery) => Promise<any>;
        /**
       * @deprecated Use transport.getPeer instead
       */
        peerInfo: (nodeName: string) => Promise<any>;
        getPeer: (nodeName: string) => Promise<any>;
        queryReliableMessages: (query: IQuery) => Promise<any>;
        queryReliableMessageAcks: (query: IQuery) => Promise<any>;
    };
    domain: {
        listDomains: () => Promise<string[]>;
        getDomain: (name: string) => Promise<IDomain | undefined>;
        getDomainByAddress: (address: string) => Promise<IDomain | undefined>;
        querySmartContracts: (query: IQuery) => Promise<IDomainSmartContract[]>;
        getSmartContractByAddress: (address: string) => Promise<IDomainSmartContract | undefined>;
        invokeRPC: (contractAddress: string, stateQualifier: string, rpcCall: DomainInvokeRPC) => Promise<any>;
    };
    bidx: {
        getBlockByNumber: (number: number) => Promise<any>;
        getTransactionByHash: (hash: string) => Promise<any>;
        getTransactionByNonce: (from: string, nonce: number) => Promise<any>;
        getBlockTransactionsByNumber: (blockNumber: number) => Promise<any>;
        getTransactionEventsByHash: (hash: string) => Promise<any>;
        queryIndexedBlocks: (query: IQuery) => Promise<any>;
        queryIndexedTransactions: (query: IQuery) => Promise<any>;
        queryIndexedEvents: (query: IQuery) => Promise<any>;
        getConfirmedBlockHeight: () => Promise<any>;
        decodeTransactionEvents: (transactionHash: string, abi: InterfaceAbi, resultFormat: string) => Promise<any>;
    };
    debug: {
        getTransactionStatus: (txID: string) => Promise<any>;
    };
    reg: {
        registries: () => Promise<any>;
        queryEntries: (registryName: string, query: IQuery, activeFilter: ActiveFilter) => Promise<any>;
        queryEntriesWithProps: (registryName: string, query: IQuery, activeFilter: ActiveFilter) => Promise<any>;
        getEntryProperties: (registryName: string, entryId: string, activeFilter: ActiveFilter) => Promise<any>;
    };
}
