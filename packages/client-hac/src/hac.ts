import { Ed25519, Ed25519Keypair } from "@cosmjs/crypto";
import { sha256 } from "@cosmjs/crypto";
import { toHex, fromHex, fromUtf8 } from "@cosmjs/encoding";
import { toBase64, fromBase64, toUtf8 } from "@cosmjs/encoding";
import { Comet38Client } from "@cosmjs/tendermint-rpc";
import * as fs from "fs";

class CometClient {
    private rpcUrl: string;
    private chainId: string;
    private privKey: Ed25519Keypair;
    public client: Comet38Client;
    public validatorAddress: string;
    public validatorIndex: number;

    constructor(rpcUrl: string, privKeyPath: string) {
        this.rpcUrl = rpcUrl;
        this.client = null as any;
        const privValidatorKey = parsePrivValidatorKey(privKeyPath);

        if (privValidatorKey.priv_key.type !== "tendermint/PrivKeyEd25519") {
            throw new Error("Unsupported key type. Only Ed25519 is supported.");
        }

        const privateKeyBytes = fromBase64(privValidatorKey.priv_key.value);

        const publicKeyBytes = fromBase64(privValidatorKey.pub_key.value);

        const keypair = new Ed25519Keypair(
            privateKeyBytes.slice(0, 32),
            publicKeyBytes.slice(0, 32)
        );
        this.privKey = keypair;
        this.validatorAddress = calculateAddress(keypair);
    }

    private async initializeClient() {
        this.client = await Comet38Client.connect(this.rpcUrl);
        let resp = await this.client.genesis();
        this.chainId = resp.chainId;
        console.log("chainId:", this.chainId);
    }

    public async sendProposal(
        proposal: string,
        title: string
    ): Promise<string> {
        if (this.client === null) {
            try {
                await this.initializeClient();
            } catch (error) {
                console.error(
                    "Error caught in try-catch:",
                    (error as Error).message
                );
                return Promise.reject("Error: " + (error as Error).message);
            }
        }
        let validatorIndex = 0;
        let nonce = 0;
        var acc;
        try {
            acc = await this.client.abciQuery({
                path: "/accounts/",
                data: fromHex(this.validatorAddress),
            });
        } catch (error) {
            console.error(
                "Error caught in try-catch:",
                (error as Error).message
            );
            return Promise.reject("Error: " + (error as Error).message);
        }

        if (acc.code === 0) {
            let accObj = JSON.parse(fromUtf8(acc.value));
            console.log(accObj);
            validatorIndex = accObj.index;
            nonce = accObj.nonce;
            let tx = {
                version: 1,
                type: 1,
                nonce: nonce,
                validator: validatorIndex,
                tx: {
                    endHeight: 1000000,
                    title: title,
                    imageUrl: "",
                    link: "",
                    data: toBase64(toUtf8(proposal)),
                },
                sig: [toBase64(toUtf8(this.chainId))],
            };
            let data = JSON.stringify(tx);
            console.log(data);
            let signatureHex = "";
            try {
                signatureHex = await signMessage(this.privKey, data);
            } catch (error) {
                console.error(
                    "Error caught in try-catch:",
                    (error as Error).message
                );
                return Promise.reject("Error: " + (error as Error).message);
            }
            tx.sig = [toBase64(fromHex(signatureHex))];
            try {
                let res = await this.client.broadcastTxSync({
                    tx: toUtf8(JSON.stringify(tx)),
                });
                return toHex(res.hash);
            } catch (error) {
                console.error(
                    "Error caught in try-catch:",
                    (error as Error).message
                );
                return Promise.reject("Error: " + (error as Error).message);
            }
        } else {
            return Promise.reject("Error: Account not found");
        }
    }

    public async sendDiscussion(
        comment: string,
        proposal: number
    ): Promise<string> {
        if (this.client === null) {
            try {
                await this.initializeClient();
            } catch (error) {
                console.error(
                    "Error caught in try-catch:",
                    (error as Error).message
                );
                return Promise.reject("Error: " + (error as Error).message);
            }
        }
        let validatorIndex = 0;
        let nonce = 0;
        var acc;
        try {
            acc = await this.client.abciQuery({
                path: "/accounts/",
                data: fromHex(this.validatorAddress),
            });
        } catch (error) {
            console.error(
                "Error caught in try-catch:",
                (error as Error).message
            );
            return Promise.reject("Error: " + (error as Error).message);
        }

        if (acc.code === 0) {
            let accObj = JSON.parse(fromUtf8(acc.value));
            console.log(accObj);
            validatorIndex = accObj.index;
            nonce = accObj.nonce;
            let tx = {
                version: 1,
                type: 2,
                nonce: nonce,
                validator: validatorIndex,
                tx: {
                    proposal: proposal,
                    data: toBase64(toUtf8(comment)),
                },
                sig: [toBase64(toUtf8(this.chainId))],
            };
            let data = JSON.stringify(tx);
            console.log(data);
            let signatureHex = "";
            try {
                signatureHex = await signMessage(this.privKey, data);
            } catch (error) {
                console.error(
                    "Error caught in try-catch:",
                    (error as Error).message
                );
                return Promise.reject("Error: " + (error as Error).message);
            }
            tx.sig = [toBase64(fromHex(signatureHex))];
            try {
                let res = await this.client.broadcastTxSync({
                    tx: toUtf8(JSON.stringify(tx)),
                });
                return toHex(res.hash);
            } catch (error) {
                console.error(
                    "Error caught in try-catch:",
                    (error as Error).message
                );
                return Promise.reject("Error: " + (error as Error).message);
            }
        } else {
            return Promise.reject("Error: Account not found");
        }
    }
}

interface PrivValidatorKey {
    address: string;
    pub_key: {
        type: string;
        value: string;
    };
    priv_key: {
        type: string;
        value: string;
    };
}

function parsePrivValidatorKey(filePath: string): PrivValidatorKey {
    try {
        const jsonData = fs.readFileSync(filePath, "utf-8");
        const privValidatorKey = JSON.parse(jsonData) as PrivValidatorKey;
        // Validate required fields
        if (
            !privValidatorKey.address ||
            !privValidatorKey.pub_key ||
            !privValidatorKey.priv_key
        ) {
            throw new Error("Invalid private validator key format.");
        }
        return privValidatorKey;
    } catch (error) {
        throw new Error(
            `Failed to parse private validator key: ${error.message}`
        );
    }
}

async function signMessage(keypair: Ed25519Keypair, message: string) {
    const messageBytes = toUtf8(message);
    const signature = await Ed25519.createSignature(messageBytes, keypair);
    return toHex(signature);
}

function calculateAddress(keypair: Ed25519Keypair): string {
    const publicKey = keypair.pubkey;
    const hashed = sha256(publicKey);
    const address = hashed.slice(0, 20);
    return toHex(address);
}

// (async () => {
//     const filePath = "./priv_validator_key.json";
//     try {
//         const client = new CometClient("http://localhost:26617", filePath);
//         let comment =
//             '{"sentiment":"positive","feedback":"Wow, this proposal is super exciting! I love the direction you’re taking with decentralization – it really captures the spirit of Web3. The ideas feel fresh and innovative. Can’t wait to see how this evolves and contributes to the community. Keep it up! 1111';
//         const hash = await client.sendDiscussion(comment, 4);
//         console.log("tx hash:", hash);
//     } catch (error) {
//         console.error("Error:", error);
//     }
// })();

export { CometClient };
