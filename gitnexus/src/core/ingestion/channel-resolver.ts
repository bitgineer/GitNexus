/**
 * Channel Resolver
 *
 * Matches message producers to consumers by shared string-literal channel names.
 * Supports: Electron IPC, Socket.IO, Node EventEmitter, C# EventEmitter/SocketIoWrapper.
 *
 * Design follows the Route Registry pattern (Phase 3.5):
 *   1. Collect all ExtractedChannel entries from parsing
 *   2. Build a Map<channelName, { producers[], consumers[] }>
 *   3. For each matched pair, emit a synthetic CALLS edge (producer → consumer)
 *
 * Edges use the existing CALLS type with a descriptive `reason` field
 * so they integrate seamlessly with community detection, flow detection,
 * and impact analysis — no schema changes required.
 */

import type { KnowledgeGraph } from '../graph/types.js';
import type { ExtractedChannel, ExtractedEventRef, ExtractedContextRef, FileConstValues } from './workers/parse-worker.js';
import { generateId } from '../../lib/utils.js';

interface ChannelEndpoint {
  filePath: string;
  enclosingSymbolId: string;
  transport: string;
  lineNumber: number;
}

interface ChannelEntry {
  producers: ChannelEndpoint[];
  consumers: ChannelEndpoint[];
}

export interface ChannelResolverStats {
  totalChannels: number;
  matchedChannels: number;
  edgesCreated: number;
  byTransport: Record<string, number>;
}

/**
 * Build a channel registry and emit CALLS edges for matched producer→consumer pairs.
 *
 * For each channel where at least one producer AND one consumer exist,
 * creates a CALLS edge from every producer's enclosing symbol to every
 * consumer's enclosing symbol. This bridges runtime dispatch boundaries
 * (IPC, WebSocket, EventEmitter) that tree-sitter CALLS extraction cannot see.
 *
 * Edge direction follows data flow:
 *   - For invoke/emit patterns: producer (caller) → consumer (handler)
 *     e.g., ipcRenderer.invoke('start-stream') → ipcMain.handle('start-stream', fn)
 *   - For push patterns: producer (sender) → consumer (listener)
 *     e.g., webContents.send('stream-ready') → ipcRenderer.on('stream-ready', fn)
 */
export function resolveChannels(
  graph: KnowledgeGraph,
  channels: ExtractedChannel[],
): ChannelResolverStats {
  const stats: ChannelResolverStats = {
    totalChannels: 0,
    matchedChannels: 0,
    edgesCreated: 0,
    byTransport: {},
  };

  if (channels.length === 0) return stats;

  // Build the channel registry: group by channelName
  const registry = new Map<string, ChannelEntry>();

  for (const ch of channels) {
    let entry = registry.get(ch.channelName);
    if (!entry) {
      entry = { producers: [], consumers: [] };
      registry.set(ch.channelName, entry);
    }

    const endpoint: ChannelEndpoint = {
      filePath: ch.filePath,
      enclosingSymbolId: ch.enclosingSymbolId,
      transport: ch.transport,
      lineNumber: ch.lineNumber,
    };

    if (ch.role === 'producer') {
      entry.producers.push(endpoint);
    } else {
      entry.consumers.push(endpoint);
    }
  }

  stats.totalChannels = registry.size;

  // Emit CALLS edges for matched channels
  const seenEdges = new Set<string>();

  for (const [channelName, entry] of registry) {
    if (entry.producers.length === 0 || entry.consumers.length === 0) continue;

    stats.matchedChannels++;

    for (const producer of entry.producers) {
      for (const consumer of entry.consumers) {
        // Skip self-edges (producer and consumer in same function)
        if (producer.enclosingSymbolId === consumer.enclosingSymbolId) continue;

        // Deduplicate: same source→target pair for same channel
        const edgeKey = `${producer.enclosingSymbolId}->${consumer.enclosingSymbolId}:${channelName}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);

        // Determine transport label for the edge reason
        const transport = producer.transport || consumer.transport;
        const reason = `channel:${transport}:${channelName}`;

        graph.addRelationship({
          id: generateId('CALLS', edgeKey),
          sourceId: producer.enclosingSymbolId,
          targetId: consumer.enclosingSymbolId,
          type: 'CALLS',
          confidence: 0.95,
          reason,
        });

        stats.edgesCreated++;
        stats.byTransport[transport] = (stats.byTransport[transport] || 0) + 1;
      }
    }
  }

  return stats;
}

export interface ContextResolverStats {
  totalContexts: number;
  matchedContexts: number;
  edgesCreated: number;
}

/**
 * Resolve React Context Provider→Consumer edges.
 *
 * Groups ExtractedContextRef entries by contextName. For each context with
 * both a provider and at least one consumer, creates CALLS edges from
 * the provider's enclosing component to each consumer's enclosing component.
 * This makes cross-component data flow through React Context visible.
 */
export function resolveContexts(
  graph: KnowledgeGraph,
  contextRefs: ExtractedContextRef[],
): ContextResolverStats {
  const stats: ContextResolverStats = {
    totalContexts: 0,
    matchedContexts: 0,
    edgesCreated: 0,
  };

  if (contextRefs.length === 0) return stats;

  const registry = new Map<string, { providers: ExtractedContextRef[]; consumers: ExtractedContextRef[] }>();

  for (const ref of contextRefs) {
    let entry = registry.get(ref.contextName);
    if (!entry) {
      entry = { providers: [], consumers: [] };
      registry.set(ref.contextName, entry);
    }
    if (ref.role === 'provider') {
      entry.providers.push(ref);
    } else {
      entry.consumers.push(ref);
    }
  }

  stats.totalContexts = registry.size;
  const seenEdges = new Set<string>();

  for (const [contextName, entry] of registry) {
    if (entry.providers.length === 0 || entry.consumers.length === 0) continue;

    stats.matchedContexts++;

    for (const prov of entry.providers) {
      for (const cons of entry.consumers) {
        if (prov.enclosingSymbolId === cons.enclosingSymbolId) continue;

        const edgeKey = `${prov.enclosingSymbolId}->${cons.enclosingSymbolId}:ctx:${contextName}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);

        graph.addRelationship({
          id: generateId('CALLS', edgeKey),
          sourceId: prov.enclosingSymbolId,
          targetId: cons.enclosingSymbolId,
          type: 'CALLS',
          confidence: 0.95,
          reason: `react-context:${contextName}`,
        });

        stats.edgesCreated++;
      }
    }
  }

  return stats;
}

/**
 * Resolve cross-file const and object property channel names.
 */
export function resolveConstChannelNames(
  channels: ExtractedChannel[],
  allConstValues: FileConstValues[],
  importMap: ReadonlyMap<string, ReadonlySet<string>>,
): number {
  const constsByFile = new Map<string, Map<string, string>>();
  const objectsByFile = new Map<string, Map<string, Map<string, string>>>();

  for (const fv of allConstValues) {
    const cm = new Map<string, string>();
    for (const [k, v] of fv.consts) cm.set(k, v);
    if (cm.size > 0) constsByFile.set(fv.filePath, cm);

    const om = new Map<string, Map<string, string>>();
    for (const [objName, props] of fv.objectProps) {
      const pm = new Map<string, string>();
      for (const [k, v] of props) pm.set(k, v);
      om.set(objName, pm);
    }
    if (om.size > 0) objectsByFile.set(fv.filePath, om);
  }

  let resolved = 0;

  for (const ch of channels) {
    // Pattern 2: Object member placeholder — @ObjName.PropName
    if (ch.channelName.startsWith('@') && ch.channelName.includes('.')) {
      const dotIdx = ch.channelName.indexOf('.');
      const objName = ch.channelName.substring(1, dotIdx);
      const propName = ch.channelName.substring(dotIdx + 1);

      const sameFileObjects = objectsByFile.get(ch.filePath);
      if (sameFileObjects?.get(objName)?.has(propName)) {
        ch.channelName = sameFileObjects.get(objName)!.get(propName)!;
        resolved++;
        continue;
      }

      const fileImports = importMap.get(ch.filePath);
      if (fileImports) {
        let found = false;
        for (const sourceFile of fileImports) {
          const sourceObjects = objectsByFile.get(sourceFile);
          if (sourceObjects) {
            if (sourceObjects.get(objName)?.has(propName)) {
              ch.channelName = sourceObjects.get(objName)!.get(propName)!;
              resolved++;
              found = true;
              break;
            }
            for (const [, props] of sourceObjects) {
              if (props.has(propName)) {
                ch.channelName = props.get(propName)!;
                resolved++;
                found = true;
                break;
              }
            }
          }
          if (found) break;
        }
      }
      continue;
    }

    // Pattern 1: Variable const name (UPPERCASE)
    if (!ch.channelName.match(/^[A-Z_][A-Z0-9_]*$/)) continue;

    const sameFileConsts = constsByFile.get(ch.filePath);
    if (sameFileConsts?.has(ch.channelName)) {
      ch.channelName = sameFileConsts.get(ch.channelName)!;
      resolved++;
      continue;
    }

    const fileImports = importMap.get(ch.filePath);
    if (fileImports) {
      for (const sourceFile of fileImports) {
        const sourceConsts = constsByFile.get(sourceFile);
        if (sourceConsts?.has(ch.channelName)) {
          ch.channelName = sourceConsts.get(ch.channelName)!;
          resolved++;
          break;
        }
      }
    }
  }

  return resolved;
}

export interface EventResolverStats {
  totalEvents: number;
  matchedEvents: number;
  edgesCreated: number;
}

/**
 * Resolve C# event fire→subscriber edges.
 *
 * Groups ExtractedEventRef entries by eventName, then creates CALLS edges
 * from each fire site's enclosing function to each subscriber site's enclosing function.
 *
 * Scoping: only matches fire→subscribe pairs where both reference the same event name.
 * Further scoping by receiver type (e.g., only link _socket.OnConnected fire to
 * _socket.OnConnected subscribers) would require type resolution and is left for Tier 3.
 */
export function resolveEvents(
  graph: KnowledgeGraph,
  eventRefs: ExtractedEventRef[],
): EventResolverStats {
  const stats: EventResolverStats = {
    totalEvents: 0,
    matchedEvents: 0,
    edgesCreated: 0,
  };

  if (eventRefs.length === 0) return stats;

  // Group by eventName
  const registry = new Map<string, { fires: ExtractedEventRef[]; subscribes: ExtractedEventRef[] }>();

  for (const ref of eventRefs) {
    let entry = registry.get(ref.eventName);
    if (!entry) {
      entry = { fires: [], subscribes: [] };
      registry.set(ref.eventName, entry);
    }
    if (ref.role === 'fire') {
      entry.fires.push(ref);
    } else {
      entry.subscribes.push(ref);
    }
  }

  stats.totalEvents = registry.size;
  const seenEdges = new Set<string>();

  for (const [eventName, entry] of registry) {
    if (entry.fires.length === 0 || entry.subscribes.length === 0) continue;

    stats.matchedEvents++;

    for (const fire of entry.fires) {
      for (const sub of entry.subscribes) {
        if (fire.enclosingSymbolId === sub.enclosingSymbolId) continue;

        const edgeKey = `${fire.enclosingSymbolId}->${sub.enclosingSymbolId}:event:${eventName}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);

        graph.addRelationship({
          id: generateId('CALLS', edgeKey),
          sourceId: fire.enclosingSymbolId,
          targetId: sub.enclosingSymbolId,
          type: 'CALLS',
          confidence: 0.85,
          reason: `channel:csharp-event:${eventName}`,
        });

        stats.edgesCreated++;
      }
    }
  }

  return stats;
}
