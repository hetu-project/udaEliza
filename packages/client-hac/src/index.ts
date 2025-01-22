import bodyParser from "body-parser";
import cors from "cors";
import express, { Request as ExpressRequest } from "express";
import multer from "multer";
import {
    AgentRuntime,
    elizaLogger,
    messageCompletionFooter,
    Media,
    getEmbeddingZeroVector,
    composeContext,
    generateMessageResponse,
    Content,
    Memory,
    ModelClass,
    Client,
    stringToUuid,
    settings,
    IAgentRuntime,
    getEnvVariable,
    generateText,
} from "@elizaos/core";
import { createApiRouter } from "./api.ts";
import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import {
    voteNegitiveProposalTemplate,
    votePositiveProposalTemplate,
    votePositiveGrantTemplate,
    discussionChillTemplate,
    summarySelfIntro,
    discussionProfessionalTemplate,
} from "./templates.ts";
import { CometClient } from "./hac.ts";
import { randomUUID } from "crypto";

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(process.cwd(), "data", "uploads");
        // Create the directory if it doesn't exist
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    },
});

// some people have more memory than disk.io
const upload = multer({ storage /*: multer.memoryStorage() */ });

export const messageHandlerTemplate =
    // {{goals}}
    // "# Action Examples" is already included
    `{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

export const hyperfiHandlerTemplate = `{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.

Response format should be formatted in a JSON block like this:
\`\`\`json
{ "lookAt": "{{nearby}}" or null, "emote": "{{emotes}}" or null, "say": "string" or null, "actions": (array of strings) or null }
\`\`\`
`;

export class DirectClient {
    public app: express.Application;
    private agents: Map<string, AgentRuntime>; // container management
    private server: any; // Store server instance
    public startAgent: Function; // Store startAgent functor
    public cometClient: CometClient;
    public character: string;

    constructor() {
        elizaLogger.log("DirectClient constructor");
        let rpcUrl = getEnvVariable("COMET_URL", "http://127.0.0.1:26617");
        elizaLogger.log("comet url", rpcUrl);
        let privKeyPath = getEnvVariable(
            "COMET_PRIVKEY",
            "./priv_validator_key.json"
        );
        elizaLogger.log("privkey path", privKeyPath);
        this.cometClient = new CometClient(rpcUrl, privKeyPath);
        this.app = express();
        this.app.use(cors());
        this.agents = new Map();

        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));

        // Serve both uploads and generated images
        this.app.use(
            "/media/uploads",
            express.static(path.join(process.cwd(), "/data/uploads"))
        );
        this.app.use(
            "/media/generated",
            express.static(path.join(process.cwd(), "/generatedImages"))
        );

        const apiRouter = createApiRouter(this.agents, this);
        this.app.use(apiRouter);

        // Define an interface that extends the Express Request interface
        interface CustomRequest extends ExpressRequest {
            file?: Express.Multer.File;
        }

        // Update the route handler to use CustomRequest instead of express.Request
        this.app.post(
            "/:agentId/whisper",
            upload.single("file"),
            async (req: CustomRequest, res: express.Response) => {
                const audioFile = req.file; // Access the uploaded file using req.file
                const agentId = req.params.agentId;

                if (!audioFile) {
                    res.status(400).send("No audio file provided");
                    return;
                }

                let runtime = this.agents.get(agentId);
                const apiKey = runtime.getSetting("OPENAI_API_KEY");

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const openai = new OpenAI({
                    apiKey,
                });

                const transcription = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(audioFile.path),
                    model: "whisper-1",
                });

                res.json(transcription);
            }
        );
        this.app.post(
            "/:agentId/selfintro",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                if (this.character && this.character.length > 0) {
                    res.json({ character: this.character });
                    return;
                }
                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                if (runtime.character.selfIntro) {
                    this.character = runtime.character.selfIntro;
                    res.json({ character: this.character });
                    return;
                }

                const userId = randomUUID();
                const roomId = randomUUID();
                await runtime.ensureConnection(userId, roomId);

                const text = JSON.stringify(runtime.character);

                const attachments: Media[] = [];
                const content: Content = {
                    text,
                    attachments,
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                let state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });
                state.recentMessages = text;
                const context = composeContext({
                    state,
                    template: summarySelfIntro,
                });

                elizaLogger.info("new selfintro context:", context);

                const response = await generateText({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });
                elizaLogger.info("response:", response);
                this.character = response;
                res.json({ character: this.character });
            }
        );
        this.app.post(
            "/:agentId/proposal",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                if (!req.body.proposalId) {
                    res.status(400).send("No proposalId provided");
                    return;
                }
                // roomId is proposal id
                const roomId = stringToUuid(req.body.proposalId);
                if (!req.body.validatorAddress) {
                    res.status(400).send("No validatorAddress provided");
                    return;
                }
                // user id is validator address
                const userId = stringToUuid(req.body.validatorAddress);

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.validatorAddress,
                    req.body.validatorAddress,
                    "direct"
                );

                let existMemories =
                    await runtime.messageManager.getMemoriesByRoomIds({
                        roomIds: [roomId],
                    });
                if (existMemories && existMemories.length > 0) {
                    res.status(200).send("Proposal already exists");
                    return;
                }

                const text = req.body.text;
                //todo:format text

                // if empty text, directly return
                if (!text) {
                    res.status(400).send("No text provided");
                    return;
                }

                const messageId = stringToUuid(Date.now().toString());

                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };
                // save response to memory
                const responseMessage: Memory = {
                    id: stringToUuid(messageId + "-" + runtime.agentId),
                    ...userMessage,
                    userId: userId,
                    content: userMessage.content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(responseMessage);
                res.status(200).send("ok");
            }
        );

        this.app.post(
            "/:agentId/discussion",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                if (!req.body.proposalId) {
                    res.status(400).send("No proposalId provided");
                    return;
                }
                // roomId is proposal id
                const roomId = stringToUuid(req.body.proposalId);
                if (!req.body.validatorAddress) {
                    res.status(400).send("No validatorAddress provided");
                    return;
                }
                // user id is validator address
                const userId = stringToUuid(req.body.validatorAddress);

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.validatorAddress,
                    req.body.validatorAddress,
                    "direct"
                );
                let existMemories =
                    await runtime.messageManager.getMemoriesByRoomIds({
                        roomIds: [roomId],
                    });
                if (!existMemories || existMemories.length === 0) {
                    res.status(400).send("Proposal not found");
                    return;
                }

                const text = req.body.text;
                //todo:format text

                // if empty text, directly return
                if (!text) {
                    res.status(400).send("No text provided");
                    return;
                }

                const messageId = stringToUuid(Date.now().toString());

                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };
                // save response to memory
                const responseMessage: Memory = {
                    id: stringToUuid(messageId + "-" + runtime.agentId),
                    ...userMessage,
                    userId: userId,
                    content: userMessage.content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(responseMessage);
                res.status(200).send("ok");
            }
        );

        this.app.post(
            "/:agentId/message",
            upload.single("file"),
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + agentId
                );
                const userId = stringToUuid(req.body.userId ?? "user");

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const text = req.body.text;
                // if empty text, directly return
                if (!text) {
                    res.json([]);
                    return;
                }

                const messageId = stringToUuid(Date.now().toString());

                const attachments: Media[] = [];
                if (req.file) {
                    const filePath = path.join(
                        process.cwd(),
                        "data",
                        "uploads",
                        req.file.filename
                    );
                    attachments.push({
                        id: Date.now().toString(),
                        url: filePath,
                        title: req.file.originalname,
                        source: "direct",
                        description: `Uploaded file: ${req.file.originalname}`,
                        text: "",
                        contentType: req.file.mimetype,
                    });
                }

                const content: Content = {
                    text,
                    attachments,
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const memory: Memory = {
                    id: stringToUuid(messageId + "-" + userId),
                    ...userMessage,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.addEmbeddingToMemory(memory);
                await runtime.messageManager.createMemory(memory);

                let state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                // save response to memory
                const responseMessage: Memory = {
                    id: stringToUuid(messageId + "-" + runtime.agentId),
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                    embedding: getEmbeddingZeroVector(),
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(responseMessage);

                state = await runtime.updateRecentMessageState(state);

                let message = null as Content | null;

                await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    async (newMessages) => {
                        message = newMessages;
                        return [memory];
                    }
                );

                await runtime.evaluate(memory, state);

                // Check if we should suppress the initial message
                const action = runtime.actions.find(
                    (a) => a.name === response.action
                );
                const shouldSuppressInitialMessage =
                    action?.suppressInitialMessage;

                if (!shouldSuppressInitialMessage) {
                    if (message) {
                        res.json([response, message]);
                    } else {
                        res.json([response]);
                    }
                } else {
                    if (message) {
                        res.json([message]);
                    } else {
                        res.json([]);
                    }
                }
            }
        );

        this.app.post(
            "/:agentId/voteproposal",
            upload.single("file"),
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                if (!req.body.proposalId) {
                    res.status(400).send("No proposalId provided");
                    return;
                }
                // roomId is proposal id
                const roomId = stringToUuid(req.body.proposalId);
                if (!req.body.validatorAddress) {
                    res.status(400).send("No validatorAddress provided");
                    return;
                }
                // user id is validator address
                const userId = stringToUuid(req.body.validatorAddress);

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                let existMemories =
                    await runtime.messageManager.getMemoriesByRoomIds({
                        roomIds: [roomId],
                    });
                if (!existMemories || existMemories.length === 0) {
                    res.status(400).send("Proposal not found");
                    return;
                }

                const text = req.body.text;

                const attachments: Media[] = [];

                const content: Content = {
                    text,
                    attachments,
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                let state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template:
                        runtime.character.templates.hacVoteProposalTemplate ||
                        votePositiveProposalTemplate,
                });

                elizaLogger.info("context", context);

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });
                elizaLogger.info("response:", response);

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }
                let vote = "error";
                if (response && response.decision) {
                    if (
                        typeof response.decision === "string" &&
                        response.decision.includes("yes")
                    ) {
                        vote = "yes";
                    } else if (
                        typeof response.decision === "string" &&
                        response.decision.includes("no")
                    ) {
                        vote = "no";
                    }
                }
                res.json({ vote });
            }
        );

        this.app.post(
            "/:agentId/newdiscussion",
            upload.single("file"),
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                if (!req.body.proposalId) {
                    res.status(400).send("No proposalId provided");
                    return;
                }
                // roomId is proposal id
                const roomId = stringToUuid(req.body.proposalId);
                if (!req.body.validatorAddress) {
                    res.status(400).send("No validatorAddress provided");
                    return;
                }
                // user id is validator address
                const userId = stringToUuid(req.body.validatorAddress);

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                let existMemories =
                    await runtime.messageManager.getMemoriesByRoomIds({
                        roomIds: [roomId],
                    });
                if (!existMemories || existMemories.length === 0) {
                    res.status(400).send("Proposal not found");
                    return;
                }

                const text = req.body.text;

                const attachments: Media[] = [];
                if (req.file) {
                    const filePath = path.join(
                        process.cwd(),
                        "data",
                        "uploads",
                        req.file.filename
                    );
                    attachments.push({
                        id: Date.now().toString(),
                        url: filePath,
                        title: req.file.originalname,
                        source: "direct",
                        description: `Uploaded file: ${req.file.originalname}`,
                        text: "",
                        contentType: req.file.mimetype,
                    });
                }

                const content: Content = {
                    text,
                    attachments,
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                let state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template:
                        runtime.character.templates.hacDiscussionTemplate ||
                        discussionChillTemplate,
                });

                elizaLogger.info("new discussion context:", context);

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });
                try {
                    let txHash = await this.cometClient.sendDiscussion(
                        String(response.feedback),
                        parseInt(req.body.proposalId, 10)
                    );
                    elizaLogger.info("discussion txHash:", txHash);
                    response.txHash = txHash;
                } catch (e) {
                    elizaLogger.error("sendDiscussion error:", e);
                }
                res.json(response);
            }
        );

        this.app.post(
            "/:agentId/votegrant",
            upload.single("file"),
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                if (!req.body.grantId) {
                    res.status(400).send("No grantId provided");
                    return;
                }
                // roomId is grant id
                const roomId = stringToUuid("grant-" + req.body.grantId);
                if (!req.body.validatorAddress) {
                    res.status(400).send("No validatorAddress provided");
                    return;
                }
                // user id is validator address
                const userId = stringToUuid(req.body.validatorAddress);

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const text = req.body.text;
                const attachments: Media[] = [];

                const content: Content = {
                    text,
                    attachments,
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const messageId = stringToUuid(Date.now().toString());
                const memory: Memory = {
                    id: stringToUuid(messageId + "-" + userId),
                    ...userMessage,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };
                await runtime.messageManager.createMemory(memory);

                let state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template:
                        runtime.character.templates.hacVoteGrantTemplate ||
                        votePositiveGrantTemplate,
                });
                state = await runtime.updateRecentMessageState(state);

                elizaLogger.info("context", context);

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });
                elizaLogger.info("response:", response);

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }
                let vote = "error";
                if (response && response.decision) {
                    if (
                        typeof response.decision === "string" &&
                        response.decision.includes("yes")
                    ) {
                        vote = "yes";
                    } else if (
                        typeof response.decision === "string" &&
                        response.decision.includes("no")
                    ) {
                        vote = "no";
                    }
                }
                res.json({ vote });
            }
        );
    }

    // agent/src/index.ts:startAgent calls this
    public registerAgent(runtime: AgentRuntime) {
        // register any plugin endpoints?
        // but once and only once
        this.agents.set(runtime.agentId, runtime);
    }

    public unregisterAgent(runtime: AgentRuntime) {
        this.agents.delete(runtime.agentId);
    }

    public start(port: number) {
        this.server = this.app.listen(port, () => {
            elizaLogger.success(
                `REST API bound to 0.0.0.0:${port}. If running locally, access it at http://localhost:${port}.`
            );
        });

        // Handle graceful shutdown
        const gracefulShutdown = () => {
            elizaLogger.log("Received shutdown signal, closing server...");
            this.server.close(() => {
                elizaLogger.success("Server closed successfully");
                process.exit(0);
            });

            // Force close after 5 seconds if server hasn't closed
            setTimeout(() => {
                elizaLogger.error(
                    "Could not close connections in time, forcefully shutting down"
                );
                process.exit(1);
            }, 5000);
        };

        // Handle different shutdown signals
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGINT", gracefulShutdown);
    }

    public stop() {
        if (this.server) {
            this.server.close(() => {
                elizaLogger.success("Server stopped");
            });
        }
    }
}

export const DirectClientInterface: Client = {
    start: async (_runtime: IAgentRuntime) => {
        elizaLogger.log("DirectClientInterface start");
        const client = new DirectClient();
        const serverPort = parseInt(settings.SERVER_PORT || "3000");
        client.start(serverPort);
        return client;
    },
    stop: async (_runtime: IAgentRuntime, client?: Client) => {
        if (client instanceof DirectClient) {
            client.stop();
        }
    },
};

export default DirectClientInterface;
