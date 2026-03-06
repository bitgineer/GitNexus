#!/usr/bin/env node
/**
 * GitNexus Claude Code Plugin Hook
 *
 * PreToolUse handler — intercepts Grep/Glob/Bash searches
 * and augments with graph context from the GitNexus index.
 *
 * NOTE: SessionStart hooks are broken on Windows (Claude Code bug #23576).
 * Session context is injected via CLAUDE.md / skills instead.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Read JSON input from stdin synchronously.
 */
function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Check if a directory (or ancestor) has a .gitnexus index.
 */
function findGitNexusIndex(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, '.gitnexus'))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Extract search pattern from tool input.
 */
function extractPattern(toolName, toolInput) {
  if (toolName === 'Grep') {
    return toolInput.pattern || null;
  }

  if (toolName === 'Glob') {
    const raw = toolInput.pattern || '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? match[1] : null;
  }

  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    const tokens = cmd.split(/\s+/);
    let foundCmd = false;
    let skipNext = false;
    const flagsWithValues = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-g', '--glob', '-t', '--type', '--include', '--exclude']);

    for (const token of tokens) {
      if (skipNext) { skipNext = false; continue; }
      if (!foundCmd) {
        if (/\brg$|\bgrep$/.test(token)) foundCmd = true;
        continue;
      }
      if (token.startsWith('-')) {
        if (flagsWithValues.has(token)) skipNext = true;
        continue;
      }
      const cleaned = token.replace(/['"]/g, '');
      return cleaned.length >= 3 ? cleaned : null;
    }
    return null;
  }

  return null;
}

/**
 * Spawn a gitnexus CLI command synchronously.
 * Chooses launcher once (direct binary or npx), then runs exactly once.
 */
function runGitNexusCli(args, cwd, timeout) {
  const isWin = process.platform === 'win32';

  // Detect whether 'gitnexus' is on PATH (cheap check, no execution)
  let useDirectBinary = false;
  try {
    const which = spawnSync(
      isWin ? 'where' : 'which', ['gitnexus'],
      { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    useDirectBinary = which.status === 0;
  } catch { /* not on PATH */ }

  if (useDirectBinary) {
    return spawnSync(
      'gitnexus', args,
      { encoding: 'utf-8', timeout, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: isWin }
    );
  }
  return spawnSync(
    'npx', ['-y', 'gitnexus', ...args],
    { encoding: 'utf-8', timeout: timeout + 5000, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: isWin }
  );
}

/**
 * Find .gitnexus directory path (not just boolean).
 */
function findGitNexusDir(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.gitnexus');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * PreToolUse handler — augment searches with graph context.
 */
function handlePreToolUse(input) {
  const cwd = input.cwd || process.cwd();
  if (!findGitNexusIndex(cwd)) return;

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Bash') return;

  const pattern = extractPattern(toolName, toolInput);
  if (!pattern || pattern.length < 3) return;

  let result = '';
  try {
    const child = runGitNexusCli(['augment', '--', pattern], cwd, 8000);
    if (!child.error && child.status === 0) {
      result = child.stderr || '';
    }
  } catch { /* graceful failure */ }

  if (result && result.trim()) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: result.trim()
      }
    }));
  }
}

function emitPostToolContext(message) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message
    }
  }));
}

/**
 * PostToolUse handler — auto-reindex after git commit.
 */
function handlePostToolUse(input) {
  const toolName = input.tool_name || '';
  if (toolName !== 'Bash') return;

  const command = (input.tool_input || {}).command || '';
  if (!/\bgit\s+(commit|merge)(\s|$)/.test(command)) return;

  const toolOutput = input.tool_output || {};
  if (toolOutput.exit_code !== undefined && toolOutput.exit_code !== 0) return;

  const cwd = input.cwd || process.cwd();
  const gitNexusDir = findGitNexusDir(cwd);
  if (!gitNexusDir) return;

  // Check if embeddings were previously generated
  let hadEmbeddings = false;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(gitNexusDir, 'meta.json'), 'utf-8'));
    hadEmbeddings = (meta.stats && meta.stats.embeddings > 0);
  } catch { /* no meta — still reindex */ }

  const args = ['analyze'];
  if (hadEmbeddings) args.push('--embeddings');

  const analyzeCmd = `npx gitnexus analyze${hadEmbeddings ? ' --embeddings' : ''}`;
  const child = runGitNexusCli(args, cwd, 120000);

  if (child.error) {
    const reason = child.signal ? 'timed out' : child.error.code || 'failed';
    emitPostToolContext(`GitNexus auto-reindex ${reason}. Run \`${analyzeCmd}\` manually.`);
    return;
  }

  if (child.status === 0) {
    emitPostToolContext(`GitNexus index updated after commit.${hadEmbeddings ? ' Embeddings regenerated.' : ''}`);
  } else {
    emitPostToolContext(`GitNexus auto-reindex failed (exit ${child.status}). Run \`${analyzeCmd}\` manually.`);
  }
}

function main() {
  try {
    const input = readInput();
    const hookEvent = input.hook_event_name || '';

    if (hookEvent === 'PreToolUse') {
      handlePreToolUse(input);
    } else if (hookEvent === 'PostToolUse') {
      handlePostToolUse(input);
    }
  } catch {
    // Graceful failure
  }
}

main();
