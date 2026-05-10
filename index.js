#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { runAgent, runSync } from './llm.js';

const program = new Command();

// --- HELPER: METADATA & HASHING ---
function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return crypto.createHash('md5').update(content).digest('hex');
}

function updateMetadata(filePath, specPath) {
    const metaDir = '.easy2code';
    const metaFile = path.join(metaDir, 'metadata.json');

    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir);

    let metadata = { files: {} };
    if (fs.existsSync(metaFile)) {
        metadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    }

    metadata.files[filePath] = {
        specPath: specPath,
        lastHash: getFileHash(filePath)
    };

    fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
}

// --- CLI CONFIGURATION ---
program
  .name('easy2code')
  .description('A lightweight Spec-Driven Development CLI')
  .version('1.0.0');

// --- COMMAND: BUILD ---
program
  .command('build <specFile>')
  .description('Read a markdown spec and generate Source code')
  .option('--claude [model]', 'Use Anthropic Claude') // <-- Changed to [model]
  .option('--gemini [model]', 'Use Google Gemini')    // <-- Changed to [model]
  .option('--ollama [model]', 'Use Local Ollama')     // <-- Changed to [model]
  .option('--git', 'Automatically create a branch and commit the generated code')
  .action(async (specFile, options) => {
    
    let provider = 'claude';
    let model = 'claude-3-5-sonnet-241022';

    if (options.gemini) { provider = 'gemini'; model = options.gemini === true ? 'gemini-2.5-flash' : options.gemini; }
    else if (options.ollama) { provider = 'ollama'; model = options.ollama === true ? 'llama3.1' : options.ollama; }
    else if (options.claude) { provider = 'claude'; model = options.claude === true ? 'claude-3-5-sonnet-241022' : options.claude; }

    console.log(`🚀 Starting easy2code build`);
    console.log(`🤖 Engine: ${provider.toUpperCase()} | Model: ${model}`);
    
    if (!fs.existsSync(specFile)) {
        console.error(`❌ Error: Spec file '${specFile}' not found.`);
        process.exit(1);
    }
    const specContent = fs.readFileSync(specFile, 'utf-8');

    let memoryContext = '';
    const memoryDir = '.memory';
    if (fs.existsSync(memoryDir)) {
        const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
            const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
            memoryContext += `\n--- Rules from ${file} ---\n${content}\n`;
        }
        console.log(`✅ Loaded ${files.length} memory document(s).`);
    } else {
        console.log(`⚠️ No .memory folder found. Operating without global rules.`);
    }

    try {
        const writtenFiles = await runAgent(memoryContext, specContent, provider, model);

        // HERE IS THE TRACKING UPDATE!
        if (writtenFiles && Array.isArray(writtenFiles)) {
            writtenFiles.forEach(file => {
                updateMetadata(file.filePath, specFile);
            });
            console.log(`✅ File tracking metadata updated.`);
        }

        if (writtenFiles && options.git) {
            console.log(`\n🌿 Handling Git Automation...`);
            const baseName = path.basename(specFile, '.md').replace(/[^a-zA-Z0-9]/g, '-');
            const branchName = `easy2code/${baseName}-${Date.now()}`;
            try {
                execSync(`git checkout -b ${branchName}`, { stdio: 'ignore' });
                execSync(`git add .`, { stdio: 'ignore' });
                execSync(`git commit -m "feat: generated code from ${specFile} via easy2code"`, { stdio: 'ignore' });
                console.log(`✅ Code safely committed to new branch: ${branchName}`);
            } catch (gitError) {
                console.log(`⚠️ Git automation failed. Are you sure this is a git repo?`);
            }
        }
        console.log(`\n🎉 easy2code build complete!`);
    } catch (error) {
        console.error(`\n❌ Agent Error:`, error.message);
    }
  });

// --- COMMAND: SYNC ---
program
  .command('sync')
  .description('Automatically detect manual code changes and sync them back to specs')
  .option('--claude [model]', 'Use Anthropic Claude') // <-- Changed to [model]
  .option('--gemini [model]', 'Use Google Gemini')    // <-- Changed to [model]
  .option('--ollama [model]', 'Use Local Ollama')     // <-- Changed to [model]
  .action(async (options) => {
      const metaPath = '.easy2code/metadata.json';
      if (!fs.existsSync(metaPath)) {
          console.log("⚠️ No tracking metadata found. Run 'easy2code build' first.");
          return;
      }

      let provider = 'claude';
      let model = 'claude-3-5-sonnet-241022';
      if (options.gemini) { provider = 'gemini'; model = options.gemini === true ? 'gemini-2.5-flash' : options.gemini; }
      else if (options.ollama) { provider = 'ollama'; model = options.ollama === true ? 'llama3.1' : options.ollama; }

      const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      console.log("🔍 Scanning for manual code changes...");

      for (const [codeFile, data] of Object.entries(metadata.files)) {
          const currentHash = getFileHash(codeFile);
          // ADD THIS LINE TO DEBUG:
          console.log(`Checking ${codeFile} | Old: ${data.lastHash.substring(0,6)}... New: ${currentHash.substring(0,6)}...`);
          if (currentHash && currentHash !== data.lastHash) {
              console.log(`✨ Changes detected in ${codeFile}. Syncing to ${data.specPath}...`);
              const codeContent = fs.readFileSync(codeFile, 'utf-8');
              const specContent = fs.readFileSync(data.specPath, 'utf-8');
              
              await runSync(codeContent, specContent, data.specPath, provider, model);
              
              // Update hash after successful sync
              metadata.files[codeFile].lastHash = getFileHash(codeFile);
          }
      }
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
      console.log("🎉 Sync complete!");
  });
// --- COMMAND: CLEAN ---
program
  .command('clean')
  .description('Wipe the tracking metadata to start fresh')
  .action(() => {
      const metaDir = '.easy2code';
      if (fs.existsSync(metaDir)) {
          fs.rmSync(metaDir, { recursive: true, force: true });
          console.log('🧹 Cleaned up tracking metadata. You are ready to start fresh!');
      } else {
          console.log('✨ Project is already clean. No metadata found.');
      }
  });
// --- COMMAND: INIT & SCAN ---
program
  .command('init')
  .description('Initialize easy2code in a repository')
  .option('--scan', 'Scan the current codebase to auto-generate .memory rules')
  .option('--claude [model]', 'Use Anthropic Claude')
  .option('--gemini [model]', 'Use Google Gemini')
  .option('--ollama [model]', 'Use Local Ollama')
  .action(async (options) => {
      let provider = 'claude';
      let model = 'claude-3-5-sonnet-241022';
      if (options.gemini) { provider = 'gemini'; model = options.gemini === true ? 'gemini-2.5-flash' : options.gemini; }
      else if (options.ollama) { provider = 'ollama'; model = options.ollama === true ? 'llama3.1' : options.ollama; }

      const memoryDir = '.memory';
      if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir);

      if (!options.scan) {
          fs.writeFileSync(path.join(memoryDir, 'architecture.md'), '# Architecture Rules\n\n');
          console.log('✅ Created empty .memory directory.');
          return;
      }

      console.log('🔍 Scanning repository to extract architectural DNA...');
      
      const { execSync } = await import('child_process');
      let sampledContext = "";
      let filePathsToTry = [];

      // 1. Identify common configuration/build files to detect the tech stack
      const buildFiles = [
          'package.json', 'tsconfig.json', 'composer.json', 'requirements.txt', 
          'Gemfile', 'go.mod', 'build.gradle', 'build.gradle.kts', 'pom.xml'
      ];
      filePathsToTry.push(...buildFiles.filter(f => fs.existsSync(f)));

      // 2. Language-Agnostic Sampling
      // Instead of looking for .kt, we look for any files that aren't binary or ignored by git
      try {
          // Identify the most frequent file extensions in the repo (ignoring common noise)
          const findExtensionsCmd = `find . -type f -not -path '*/.*' -not -path '*/node_modules/*' -not -path '*/build/*' -not -path '*/dist/*' | sed 's/.*\\.//' | sort | uniq -c | sort -rn | head -n 5`;
          const commonExtensions = execSync(findExtensionsCmd).toString()
              .trim().split('\n')
              .map(line => line.trim().split(/\s+/)[1])
              .filter(ext => ext && !['png', 'jpg', 'json', 'md', 'lock', 'xml'].includes(ext));

          console.log(`📡 Detected primary extensions: ${commonExtensions.join(', ')}`);

          // For each major extension, grab a few representative files
          for (const ext of commonExtensions) {
              const files = execSync(`find . -name "*.${ext}" -not -path "*/node_modules/*" -not -path "*/build/*" | head -n 3`)
                  .toString().trim().split('\n');
              filePathsToTry.push(...files);
          }
      } catch (e) {
          console.log("⚠️ Could not perform deep file search. Falling back to root files.");
      }

      // 3. Read and append files to context
      [...new Set(filePathsToTry)].forEach(file => { // Deduplicate paths
          if (file && fs.existsSync(file) && fs.lstatSync(file).isFile()) {
              sampledContext += `\n--- File: ${file} ---\n${fs.readFileSync(file, 'utf-8').substring(0, 3000)}\n`; 
          }
      });

      if (!sampledContext) {
          console.log('❌ Could not find any recognizable code to scan.');
          return;
      }

      console.log('🧠 Analyzing stack and writing memory rules...');
      const { runScanner } = await import('./llm.js');
      await runScanner(sampledContext, provider, model);
      console.log('🎉 Repository scanned! Your .memory folder is ready.');
  });
// --- COMMAND: DEBUG (ZERO-CONFIG AUTO-HEALING) ---
program
  .command('debug')
  .description('Auto-detect stack, run checks, and iteratively heal the codebase')
  .option('--claude [model]', 'Use Anthropic Claude')
  .option('--gemini [model]', 'Use Google Gemini')
  .option('--ollama [model]', 'Use Local Ollama')
  .action(async (options) => {
      let provider = 'claude';
      let model = 'claude-3-5-sonnet-241022';
      
      if (options.gemini) { provider = 'gemini'; model = options.gemini === true ? 'gemini-2.5-flash' : options.gemini; }
      else if (options.ollama) { provider = 'ollama'; model = options.ollama === true ? 'llama3.1' : options.ollama; }
      else if (options.claude) { provider = 'claude'; model = options.claude === true ? 'claude-3-5-sonnet-241022' : options.claude; }

      const { runAutoHealLoop } = await import('./llm.js');
      // Notice we are no longer passing a command!
      await runAutoHealLoop(provider, model);
  });
program.parse(process.argv);