/**
 * `gitnexus link` — Cross-repo channel matching.
 *
 * Reads channel manifests (.gitnexus/channels.json) from all indexed repos,
 * matches producers to consumers by channel name across repo boundaries,
 * and writes a cross-repo channel registry to ~/.gitnexus/cross-repo-channels.json.
 *
 * Supported transports:
 *   TS/JS: Electron IPC, Socket.IO, EventEmitter
 *   C#:    Socket.IO wrapper, event delegates
 *   Python: Socket.IO, Celery tasks, Redis pub/sub, EventEmitter (pyee)
 *   Java:  Kafka, JMS, RabbitMQ (via Spring annotations)
 *   PHP:   WordPress hooks, Laravel events, Symfony events
 *   Go:    NATS pub/sub
 *   Ruby:  ActiveSupport::Notifications
 *   Swift: NotificationCenter
 *
 * This captures ALL channels — both matched (producer+consumer in same repo)
 * and unmatched (producer-only or consumer-only) — enabling cross-service
 * message flow tracing.
 */

import { listRegisteredRepos, getGlobalDir } from '../storage/repo-manager.js';
import path from 'node:path';
import fs from 'node:fs/promises';

interface ChannelEntry {
  channelName: string;
  role: 'producer' | 'consumer';
  transport: string;
  symbolId: string;
  filePath: string;
  line: number;
}

interface ChannelEndpoint {
  repo: string;
  repoPath: string;
  symbolId: string;
  filePath: string;
  line: number;
  transport: string;
}

interface CrossRepoChannel {
  channelName: string;
  transport: string;
  producers: ChannelEndpoint[];
  consumers: ChannelEndpoint[];
}

interface CrossRepoRegistry {
  generatedAt: string;
  reposScanned: number;
  reposWithChannels: number;
  totalChannelRefs: number;
  uniqueChannelNames: number;
  crossRepoMatches: number;
  sameRepoMatches: number;
  unmatchedProducers: number;
  unmatchedConsumers: number;
  channels: CrossRepoChannel[];
}

export const linkCommand = async (): Promise<void> => {
  console.log('\n  GitNexus Cross-Repo Linker\n');

  // Step 1: Get all indexed repos
  const repos = await listRegisteredRepos({ validate: true });
  if (repos.length === 0) {
    console.log('  No indexed repos found. Run `gitnexus analyze` first.');
    return;
  }
  console.log(`  Scanning ${repos.length} indexed repos for channel manifests...\n`);

  // Step 2: Read channels.json from each repo
  const globalRegistry = new Map<string, { producers: ChannelEndpoint[]; consumers: ChannelEndpoint[] }>();
  let reposWithChannels = 0;
  let totalRefs = 0;

  for (const repo of repos) {
    const channelsPath = path.join(repo.storagePath, 'channels.json');
    try {
      const raw = await fs.readFile(channelsPath, 'utf-8');
      const data = JSON.parse(raw) as { channels: ChannelEntry[] };
      if (!data.channels?.length) {
        console.log(`  · ${repo.name}: no channels`);
        continue;
      }

      reposWithChannels++;
      totalRefs += data.channels.length;
      const producers = data.channels.filter(c => c.role === 'producer').length;
      const consumers = data.channels.filter(c => c.role === 'consumer').length;
      console.log(`  ✓ ${repo.name}: ${data.channels.length} channels (${producers} producers, ${consumers} consumers)`);

      for (const ch of data.channels) {
        // Skip unresolved placeholders
        if (ch.channelName.startsWith('@')) continue;

        let entry = globalRegistry.get(ch.channelName);
        if (!entry) {
          entry = { producers: [], consumers: [] };
          globalRegistry.set(ch.channelName, entry);
        }

        const endpoint: ChannelEndpoint = {
          repo: repo.name,
          repoPath: repo.path,
          symbolId: ch.symbolId,
          filePath: ch.filePath,
          line: ch.line,
          transport: ch.transport,
        };

        if (ch.role === 'producer') {
          entry.producers.push(endpoint);
        } else {
          entry.consumers.push(endpoint);
        }
      }
    } catch {
      // No channels.json — repo was indexed before channel support, or has no channels
      console.log(`  · ${repo.name}: no channel manifest (re-index to generate)`);
    }
  }

  // Step 3: Classify channels
  const crossRepoChannels: CrossRepoChannel[] = [];
  const sameRepoChannels: CrossRepoChannel[] = [];
  let unmatchedProducers = 0;
  let unmatchedConsumers = 0;

  for (const [channelName, entry] of globalRegistry) {
    const hasProducers = entry.producers.length > 0;
    const hasConsumers = entry.consumers.length > 0;

    if (!hasProducers && hasConsumers) {
      unmatchedConsumers++;
      continue;
    }
    if (hasProducers && !hasConsumers) {
      unmatchedProducers++;
      continue;
    }
    if (!hasProducers && !hasConsumers) continue;

    // Has both producers and consumers — check if cross-repo
    const producerRepos = new Set(entry.producers.map(p => p.repo));
    const consumerRepos = new Set(entry.consumers.map(c => c.repo));

    let isCrossRepo = false;
    for (const pr of producerRepos) {
      for (const cr of consumerRepos) {
        if (pr !== cr) { isCrossRepo = true; break; }
      }
      if (isCrossRepo) break;
    }

    const channel: CrossRepoChannel = {
      channelName,
      transport: entry.producers[0]?.transport ?? entry.consumers[0]?.transport ?? 'unknown',
      producers: entry.producers,
      consumers: entry.consumers,
    };

    if (isCrossRepo) {
      crossRepoChannels.push(channel);
    } else {
      sameRepoChannels.push(channel);
    }
  }

  // Step 4: Write registry
  const allMatched = [...crossRepoChannels, ...sameRepoChannels].sort((a, b) => a.channelName.localeCompare(b.channelName));

  const registry: CrossRepoRegistry = {
    generatedAt: new Date().toISOString(),
    reposScanned: repos.length,
    reposWithChannels,
    totalChannelRefs: totalRefs,
    uniqueChannelNames: globalRegistry.size,
    crossRepoMatches: crossRepoChannels.length,
    sameRepoMatches: sameRepoChannels.length,
    unmatchedProducers,
    unmatchedConsumers,
    channels: allMatched,
  };

  const globalDir = getGlobalDir();
  const outputPath = path.join(globalDir, 'cross-repo-channels.json');
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(registry, null, 2));

  // Step 5: Print summary
  console.log(`\n  ── Results ──`);
  console.log(`  Repos with channels:    ${reposWithChannels}/${repos.length}`);
  console.log(`  Total channel refs:     ${totalRefs}`);
  console.log(`  Unique channel names:   ${globalRegistry.size}`);
  console.log(`  Cross-repo matches:     ${crossRepoChannels.length}`);
  console.log(`  Same-repo matches:      ${sameRepoChannels.length}`);
  console.log(`  Unmatched producers:    ${unmatchedProducers} (no consumer in any repo)`);
  console.log(`  Unmatched consumers:    ${unmatchedConsumers} (no producer in any repo)`);

  if (crossRepoChannels.length > 0) {
    console.log(`\n  Cross-repo channels:`);
    for (const ch of crossRepoChannels.sort((a, b) => a.channelName.localeCompare(b.channelName))) {
      const prods = [...new Set(ch.producers.map(p => p.repo))].join(', ');
      const cons = [...new Set(ch.consumers.map(c => c.repo))].join(', ');
      console.log(`    ${ch.channelName} (${ch.transport}): ${prods} → ${cons}`);
    }
  }

  console.log(`\n  Registry: ${outputPath}\n`);
};
