#!/usr/bin/env node
import { spawn } from 'child_process';
import { open } from 'open';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const SERVER_URL = `http://localhost:${PORT}`;

console.log('🎮 Starting Sigmacraft...');

// Start the server
const server = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: 'inherit'
});

// Wait a moment for server to start, then open browser
setTimeout(() => {
  console.log(`\n🌐 Opening ${SERVER_URL} in browser...\n`);
  open(SERVER_URL).catch(() => {
    console.log(`\n📍 Server running at ${SERVER_URL}`);
    console.log('Please open this URL in your web browser.');
  });
}, 1500);

// Handle process exit
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down Sigmacraft...');
  server.kill();
  process.exit(0);
});
