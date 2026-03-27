/**
 * Partial Class Processor
 *
 * Unifies C# partial class declarations across multiple files into a single
 * canonical class node. In C#, `partial class MyService` can be split across
 * N files — all sharing the same (namespace, className) identity. GitNexus
 * creates one Class node per file, fragmenting HAS_METHOD edges and breaking
 * impact analysis. This processor merges them.
 *
 * Algorithm:
 *   1. Find all Class/Struct/Interface nodes with a `namespace` property (C# only)
 *   2. Group by (namespace, name) — groups with >1 node are partials
 *   3. Pick canonical: the node whose file contains the heritage (extends/implements)
 *      clause, or alphabetically first file
 *   4. Re-point all HAS_METHOD/HAS_PROPERTY/DEFINES edges from duplicates to canonical
 *   5. Update symbol table ownerId references
 *   6. Remove duplicate nodes from graph
 *
 * This runs AFTER parse workers merge but BEFORE heritage/call processing,
 * so downstream processors see a unified class hierarchy.
 */

import type { KnowledgeGraph, GraphNode } from '../graph/types.js';

export interface PartialClassStats {
  groupsFound: number;
  nodesRemoved: number;
  edgesRepointed: number;
}

/**
 * Unify partial class nodes in the graph.
 *
 * Uses existing EXTENDS/IMPLEMENTS edges in the graph (already created by heritage-processor)
 * to determine which class node should be canonical (the one with the inheritance declaration).
 *
 * @param graph - In-memory knowledge graph (mutated in place)
 * @returns Stats about what was unified
 */
export function unifyPartialClasses(
  graph: KnowledgeGraph,
): PartialClassStats {
  const stats: PartialClassStats = {
    groupsFound: 0,
    nodesRemoved: 0,
    edgesRepointed: 0,
  };

  // Step 1: Find all C# class-like nodes with namespace property.
  // Group by (namespace, name) — groups with >1 node are partials.
  const groups = new Map<string, GraphNode[]>();

  for (const node of graph.iterNodes()) {
    const label = node.label;
    if (label !== 'Class' && label !== 'Struct' && label !== 'Interface' && label !== 'Record') continue;
    const ns = node.properties?.namespace as string | undefined;
    if (!ns) continue; // Not a C# node with namespace — skip

    const key = `${ns}\0${node.properties.name}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(node);
  }

  // Step 2: Build set of class node IDs that are source of EXTENDS/IMPLEMENTS edges.
  // These are the nodes whose file contains the `: BaseClass` declaration.
  const hasHeritageEdge = new Set<string>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'EXTENDS' || rel.type === 'IMPLEMENTS') {
      hasHeritageEdge.add(rel.sourceId);
    }
  }

  // Step 3: Process groups with >1 node (the partials)
  for (const [_key, nodes] of groups) {
    if (nodes.length <= 1) continue;

    stats.groupsFound++;

    // Pick canonical: prefer the node that has an EXTENDS/IMPLEMENTS edge
    let canonical = nodes[0];
    for (const node of nodes) {
      if (hasHeritageEdge.has(node.id)) {
        canonical = node;
        break;
      }
    }
    // If no heritage edge, sort by filePath and pick first (deterministic)
    if (!hasHeritageEdge.has(canonical.id)) {
      nodes.sort((a, b) => (a.properties.filePath as string).localeCompare(b.properties.filePath as string));
      canonical = nodes[0];
    }

    const canonicalId = canonical.id;
    const duplicateIds = new Set(nodes.filter(n => n.id !== canonicalId).map(n => n.id));

    // Step 4: Re-point all edges from/to duplicate nodes to canonical
    for (const rel of graph.iterRelationships()) {
      let changed = false;
      let newSourceId = rel.sourceId;
      let newTargetId = rel.targetId;

      if (duplicateIds.has(rel.sourceId)) {
        newSourceId = canonicalId;
        changed = true;
      }
      if (duplicateIds.has(rel.targetId)) {
        newTargetId = canonicalId;
        changed = true;
      }

      if (changed) {
        // Skip self-edges that would result from merging
        if (newSourceId === newTargetId) continue;
        rel.sourceId = newSourceId;
        rel.targetId = newTargetId;
        stats.edgesRepointed++;
      }
    }

    // Step 5: Remove duplicate nodes from graph
    for (const dupId of duplicateIds) {
      graph.removeNode(dupId);
      stats.nodesRemoved++;
    }
  }

  return stats;
}
