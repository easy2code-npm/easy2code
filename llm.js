import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Type } from '@google/genai';
import ollama from 'ollama';
import fs from 'fs';
import path from 'path';
import { confirm } from '@inquirer/prompts';
import { highlight } from 'cli-highlight';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

// ============================================================================
// 1. CORE AI HELPERS (The Engine)
// ============================================================================

/**
 * Standard text generation helper for all providers.
 */
async function generateText(provider, model, prompt, systemPrompt = "") {
    if (provider === 'claude') {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
            model, max_tokens: 4000, system: systemPrompt,
            messages: [{ role: "user", content: prompt }]
        });
        return msg.content[0].text;
    } 
    
    if (provider === 'gemini') {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const config = systemPrompt ? { systemInstruction: systemPrompt } : {};
        const result = await ai.models.generateContent({ model, contents: prompt, config });
        return result.text;
    } 
    
    if (provider === 'ollama') {
        const messages = [];
        if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
        messages.push({ role: "user", content: prompt });
        const response = await ollama.chat({ model, messages });
        return response.message.content;
    }
    
    throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Tool-calling helper specifically designed for the 'write_files' schema.
 */
async function generateFiles(provider, model, prompt, systemPrompt = "") {
    let files = [];

    if (provider === 'claude') {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
            model, max_tokens: 4000, system: systemPrompt,
            messages: [{ role: "user", content: prompt }],
            tools: [{
                name: "write_files",
                description: "Writes multiple source code files to disk at once.",
                input_schema: {
                    type: "object",
                    properties: {
                        files: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: { filePath: { type: "string" }, content: { type: "string" } },
                                required: ["filePath", "content"]
                            }
                        }
                    },
                    required: ["files"]
                }
            }]
        });
        
        for (const block of msg.content) {
            if (block.type === 'tool_use' && block.name === 'write_files') files.push(...block.input.files);
        }
    } 
    
    else if (provider === 'gemini') {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model, contents: prompt,
            config: {
                systemInstruction: systemPrompt,
                tools: [{
                    functionDeclarations: [{
                        name: "write_files",
                        description: "Writes multiple source code files to disk at once.",
                        parameters: {
                            type: Type.OBJECT,
                            properties: {
                                files: {
                                    type: Type.ARRAY,
                                    items: {
                                        type: Type.OBJECT,
                                        properties: { filePath: { type: Type.STRING }, content: { type: Type.STRING } },
                                        required: ["filePath", "content"]
                                    }
                                }
                            },
                            required: ["files"]
                        }
                    }]
                }],
                toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["write_files"] } }
            }
        });

        if (response.functionCalls) {
            for (const call of response.functionCalls) {
                if (call.name === 'write_files') files.push(...call.args.files);
            }
        }
    } 
    
    else if (provider === 'ollama') {
        const response = await ollama.chat({
            model,
            messages: [ { role: "system", content: systemPrompt }, { role: "user", content: prompt } ],
            tools: [{
                type: 'function',
                function: {
                    name: "write_files",
                    description: "Writes multiple source code files to disk at once.",
                    parameters: {
                        type: "object",
                        properties: {
                            files: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: { filePath: { type: "string" }, content: { type: "string" } },
                                    required: ["filePath", "content"]
                                }
                            }
                        },
                        required: ["files"]
                    }
                }
            }]
        });

        if (response.message?.tool_calls) {
            for (const tool of response.message.tool_calls) {
                if (tool.function.name === 'write_files') files.push(...tool.function.arguments.files);
            }
        }
    }

    return files;
}

// ============================================================================
// 2. UTILITY FUNCTIONS
// ============================================================================

function saveGeneratedFile(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`✅ Successfully saved ${filePath}`);
}

function detectBuildCommand() {
    console.log("🔍 Auto-detecting project tech stack...");
    
    if (fs.existsSync('package.json')) {
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
        if (pkg.scripts?.['typecheck']) return 'npm run typecheck';
        if (pkg.scripts?.['build']) return 'npm run build';
        if (pkg.scripts?.['test']) return 'npm test';
        return 'node index.js';
    }
    
    if (fs.existsSync('build.gradle') || fs.existsSync('build.gradle.kts') || fs.existsSync('app/build.gradle')) {
        const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
        if (process.platform !== 'win32' && fs.existsSync('gradlew')) fs.chmodSync('gradlew', '755');
        return `${gradlew} assembleDebug`;
    }
    
    if (fs.existsSync('pom.xml')) return 'mvn clean compile';
    if (fs.existsSync('requirements.txt') || fs.existsSync('pyproject.toml')) return 'python -m pytest || python -m unittest'; 
    if (fs.existsSync('go.mod')) return 'go build ./...';

    return null; 
}

// ============================================================================
// 3. CORE CLI LOGIC (The Workflows)
// ============================================================================

export async function runDebugger(errorLog, filePath, provider, model) {
    console.log(`\n🐛 AI Debugger is analyzing ${filePath}...`);
    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const systemPrompt = "You are an Expert Software Engineer debugging a broken build. You MUST output the fully fixed code using the write_files tool.";
        const debugPrompt = `
        Fix the following code so that it compiles and runs successfully. 
        Ensure you do not remove any existing functionality unless it is the direct cause of the error.
        
        ### Error Log:\n${errorLog}\n
        ### Source Code (${filePath}):\n${fileContent}
        `;

        const fixedFiles = await generateFiles(provider, model, debugPrompt, systemPrompt);

        if (fixedFiles && fixedFiles.length > 0) {
            fixedFiles.forEach(file => saveGeneratedFile(file.filePath, file.content));
            return fixedFiles;
        } else {
            console.log("⚠️ AI failed to return any fixed code.");
            return null;
        }
    } catch (e) {
        console.error(`❌ Debugger crashed while trying to fix ${filePath}:`, e.message);
        return null;
    }
}

async function identifyBrokenFile(errorLog, provider, model) {
    const fileMatch = errorLog.match(/([a-zA-Z0-9_\-\.\/]+\.(?:tsx|ts|jsx|js|kt|java|py|go|cpp|c|cs|rs)):\d+/i) || 
                      errorLog.match(/Error in \.?\/?([a-zA-Z0-9_\-\.\/]+\.(?:tsx|ts|jsx|js|kt|java|py|go|cpp|c|cs|rs))/i);

    if (fileMatch && fileMatch[1] && fs.existsSync(fileMatch[1].trim())) {
        console.log(`🕵️ Local Regex detected broken file: ${fileMatch[1].trim()}`);
        return fileMatch[1].trim();
    }

    console.log("🕵️ Local detection failed. Asking AI to find the broken file...");
    const prompt = `Analyze this error log and identify the PRIMARY source code file causing the failure.
    If multiple files are failing, select ONLY the FIRST file mentioned.
    CRITICAL: Your response must be ONLY a raw JSON string. Do NOT wrap it in markdown.
    Example: {"filePath": "src/App.tsx"}
    
    Error Log (truncated):
    ${errorLog.substring(0, 3000)}`;

    try {
        let responseText = await generateText(provider, model, prompt);
        
        // Clean JSON
        let cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const startIndex = cleanJson.indexOf('{');
        const endIndex = cleanJson.lastIndexOf('}');
        
        if (startIndex === -1 || endIndex === -1) throw new Error("No JSON object found");
        
        return JSON.parse(cleanJson.substring(startIndex, endIndex + 1)).filePath;
    } catch (e) {
        console.error("⚠️ Detective Error:", e.message);
        return null;
    }
}

export async function runAutoHealLoop(provider, model, maxLoops = 3) {
    const command = detectBuildCommand();
    if (!command) {
        console.log("❌ Could not auto-detect the project stack. Please run a build manually.");
        return;
    }

    console.log(`⚙️ Detected Build Strategy: "${command}"`);
    let currentLoop = 0;

    while (currentLoop < maxLoops) {
        console.log(`\n⏳ [Loop ${currentLoop + 1}/${maxLoops}] Executing under the hood...`);
        try {
            await execAsync(command);
            console.log(`\n✅ Success! No errors found. Your codebase is clean!`);
            return; 
        } catch (error) {
            const errorLog = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
            console.log(`\n❌ Error detected during "${command}"! Analyzing stack trace...`);

            const missingModuleMatch = errorLog.match(/Cannot find module '([^']+)'/);
            if (missingModuleMatch) {
                const missingPackage = missingModuleMatch[1];
                console.log(`\n📦 Dependency Issue Detected: You are missing '${missingPackage}'`);
                const shouldInstall = await confirm({ message: `Would you like me to run 'npm install ${missingPackage}'?` });
                if (shouldInstall) {
                    console.log(`\n🚀 Installing ${missingPackage}...`);
                    try {
                        await execAsync(`npm install ${missingPackage}`);
                        console.log(`✅ Successfully installed ${missingPackage}! Re-running build...`);
                        continue; 
                    } catch (installErr) {
                        console.log(`❌ Failed to install ${missingPackage}.`);
                        return;
                    }
                }
            }

            console.log(`\n🧠 Routing error to AI Detective...`);
            const filePath = await identifyBrokenFile(errorLog, provider, model);
            
            if (!filePath || !fs.existsSync(filePath)) {
                console.log(`🛑 Could not automatically locate the broken file. Please fix manually.`);
                return;
            }

            const fixedFiles = await runDebugger(errorLog, filePath, provider, model);
            if (!fixedFiles) {
                console.log(`🛑 Healing process aborted by user or AI failure.`);
                return;
            }

            console.log(`\n🔄 Fix applied! Re-running "${command}" to verify...`);
            currentLoop++;
        }
    }
    console.log(`\n⚠️ Reached maximum auto-heal loops (${maxLoops}). Please investigate manually.`);
}

export async function runScanner(sampledCode, provider, model) {
    const scannerPrompt = `
    You are an Expert Software Architect. You are onboarding onto a new codebase.
    Analyze the provided files to reverse-engineer the project standards.
    
    You MUST output exactly THREE files using the write_files tool:
    1. '.memory/stack.md' -> Identify languages, frameworks, and build tools.
    2. '.memory/architecture.md' -> Define design patterns and file structure rules.
    3. '.memory/testing.md' -> Identify the testing framework.

    ### Sampled Codebase Files:
    ${sampledCode}
    `;

    try {
        const files = await generateFiles(provider, model, scannerPrompt);
        if (files) files.forEach(file => saveGeneratedFile(file.filePath, file.content));
    } catch (e) {
        console.error("❌ Scanner Error:", e.message);
    }
}

export async function runAgent(memoryContext, specContent, provider, model) {
    console.log("🧠 Agent is analyzing specs and planning code...");

    const systemPrompt = `You are a Senior Principal Engineer and Expert Software Architect. 
    You write clean, production-ready code strictly following these architectural rules:
    ${memoryContext}`;

    const userPrompt = `Implement the following spec. 
    CRITICAL: You must write ALL production files AND their corresponding test files as dictated by the architecture rules. 
    Return an array of ALL files using the write_files tool.
    ### Spec:\n${specContent}`;

    const proposedFiles = await generateFiles(provider, model, userPrompt, systemPrompt);

    if (!proposedFiles || proposedFiles.length === 0) {
        console.log("⚠️ Agent didn't propose any file writes. Check your spec.");
        return null;
    }

    console.log("\n📋 --- CODE PREVIEW ---");
    proposedFiles.forEach((file, index) => {
        console.log(`\n===================================================================`);
        console.log(`📄 File ${index + 1}: ${file.filePath}`);
        console.log(`===================================================================\n`);
        console.log(highlight(file.content, { ignoreIllegals: true }));
    });
    console.log(`\n===================================================================`);

    const isApproved = await confirm({ message: 'Approve and write these files to disk?' });
    if (isApproved) {
        console.log("\n🚀 Executing Plan...");
        proposedFiles.forEach(file => saveGeneratedFile(file.filePath, file.content));
        return proposedFiles; 
    }
    
    console.log("\n❌ Build aborted by user. No files were written.");
    return null;
}

export async function runSync(codeContent, specContent, specPath, provider, model) {
    const syncPrompt = `
    You are a Technical Architect managing a living specification document. 
    Sync the recent manual code changes back into the Markdown Specification.
    
    CRITICAL INSTRUCTIONS:
    1. ADDITIONS: If the code has new logic, add it to the spec.
    2. DELETIONS: If logic is missing from the code, remove it from the spec.
    3. ISOLATION: ONLY modify the section describing this specific code.
    
    --- Current Spec ---\n${specContent}
    --- Current Code ---\n${codeContent}

    Return ONLY the fully updated Markdown content.
    `;

    try {
        const updatedMarkdown = await generateText(provider, model, syncPrompt);
        if (updatedMarkdown) {
            fs.writeFileSync(specPath, updatedMarkdown.trim(), 'utf-8');
            console.log(`✅ Successfully updated spec: ${specPath}`);
        }
    } catch (e) {
        console.error(`❌ Failed to sync ${specPath}:`, e.message);
    }
}