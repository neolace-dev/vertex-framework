import { VNID } from "../lib/types/vnid";
import { C, CypherQuery } from "../layer2/cypher-sugar";
import { Action, defineAction } from "./action";
import { getActionChanges } from "./action-changes";
import { Field } from "../lib/types/field";

/**
 * A generic action that can run arbitrary cypher, meant only for use in tests.
 * 
 * This cannot be inverted (is not undoable).
 */
export const GenericCypherAction = defineAction({
    type: `GenericCypherAction`,
    parameters: {} as {
        cypher: CypherQuery,
        produceResult?: (dbResult: any) => {resultData: any, modifiedNodes: VNID[]},
        modifiedNodes?: VNID[],
    },
    apply: async (tx, data) => {
        const dbResult = await tx.query(data.cypher);
        const {resultData, modifiedNodes} = data.produceResult ? data.produceResult(dbResult) : {resultData: {}, modifiedNodes: []};
        if (data.modifiedNodes) {
            modifiedNodes.push(...data.modifiedNodes);
        }
        return {resultData, modifiedNodes};
    },
    invert: (data, resultData) => null,
});

export class UndoConflictError extends Error {}

/**
 * A generic action that can run undo almost any action, except those with side effects or that permanently deleted
 * data.
 */
 export const UndoAction = defineAction({
    type: `UndoAction`,
    parameters: {} as {
        actionId: VNID,
    },
    apply: async (tx, data) => {
        const prevAction = await tx.pullOne(Action, a => a.deletedNodesCount.revertedBy(ra => ra.id), {key: data.actionId});
        if (prevAction.revertedBy !== null) {
            throw new UndoConflictError("That action was already undone.");
        }
        const changes = await getActionChanges(tx, data.actionId);

        if (changes.deletedNodesCount > 0) {
            throw new UndoConflictError("Cannot undo an Action that permanently deleted data.");
        }

        // Restore soft deleted nodes
        if (changes.softDeletedNodes.length > 0) {
            await tx.query(C`
                MATCH (n:DeletedVNode) WHERE n.id IN ${changes.softDeletedNodes}
                SET n:VNode
                REMOVE n:DeletedVNode
                RETURN NULL
            `);
        }

        // Restore any deleted relationships
        if (changes.deletedRelationships.length > 0) {
            const relsCreated = await tx.query(C`
                UNWIND ${changes.deletedRelationships} AS deletedRelationship
                MATCH (from:VNode {id: deletedRelationship.from})
                MATCH (to:VNode {id: deletedRelationship.to})
                CALL apoc.create.relationship(from, deletedRelationship.type, deletedRelationship.properties, to) YIELD rel
                RETURN rel
            `);
            if (relsCreated.length !== changes.deletedRelationships.length) {
                throw new UndoConflictError("One of the nodes relationships deleted by that action cannot be re-created; cannot undo.");
            }
        }

        // Change any modified properties
        if (changes.modifiedNodes.length > 0) {
            const nodesWithModifiedProperties = await tx.query(C`
                UNWIND ${changes.modifiedNodes} AS change
                MATCH (node:VNode {id: change.id})
                WITH node, change
                    UNWIND keys(change.properties) as changedPropName
                    WITH node, change.properties[changedPropName].old AS oldValue, change.properties[changedPropName].new AS newValue, changedPropName
                    WHERE (newValue IS NULL AND node[changedPropName] IS NULL) OR (node[changedPropName] = newValue)
                        CALL apoc.create.setProperty(node, changedPropName, oldValue) YIELD node AS node2
                        RETURN NULL AS x
            `);
            if (nodesWithModifiedProperties.length !== changes.modifiedNodes.length) {
                throw new UndoConflictError("One of the node properties changed by that action has since been changed; cannot undo.");
            }
        }

        // Delete any created relationships
        if (changes.createdRelationships.length > 0) {
            const relsDeleted = await tx.query(C`
                UNWIND ${changes.createdRelationships} AS createdRelationship
                MATCH (from:VNode {id: createdRelationship.from})-[rel]->(to:VNode {id: createdRelationship.to})
                WHERE type(rel) = createdRelationship.type AND properties(rel) = createdRelationship.properties
                WITH createdRelationship, head(collect(rel)) AS rel  // This ensures we only delete one relationship per "createdRelationship", in case multiple identical relationships exist.
                DELETE rel
                RETURN NULL
            `);
            if (relsDeleted.length !== changes.createdRelationships.length) {
                throw new UndoConflictError("One of the relationships created by that action cannot be deleted; cannot undo.");
            }
        }

        // Soft delete any created nodes, but also verify that they haven't been modified since they were created.
        if (changes.createdNodes.length > 0) {
            const createdNodesNow = await tx.query(C`
                MATCH (n:VNode) WHERE n.id IN ${changes.createdNodes.map(cn => cn.id)}
                SET n:DeletedVNode
                REMOVE n:VNode
            `.RETURN({n: Field.Node}));
            if (createdNodesNow.length < changes.createdNodes.length) {
                throw new UndoConflictError("One of the nodes created by that action has since been deleted; cannot undo.");
            }
            for (const row of createdNodesNow) {
                // First make sure the node hasn't changed yet
                const currentProperties = row.n.properties;
                const createdProperties = changes.createdNodes.find(cn => cn.id === row.n.properties.id)?.properties;
                if (createdProperties === undefined) {
                    throw new Error("Internal error, couldn't match current node to created node record.");
                }
                // Compare each property. Note that "createdProperties"/changes already has the field data in "raw" format
                if (Object.keys(currentProperties).length > Object.keys(createdProperties).length) {
                    throw new UndoConflictError("One of the nodes created by that action has since been modified (new property); cannot undo.");
                }
                Object.entries(createdProperties).forEach(([propName, createdValue]) => {
                    if (currentProperties[propName] ?? null !== createdValue) {
                        throw new UndoConflictError(`One of the nodes created by that action has since been modified (property ${propName} changed); cannot undo.`);
                    }
                });
            }
        }

        // Re-delete un-deleted nodes
        await tx.query(C`
            MATCH (n:VNode) WHERE n.id IN ${changes.unDeletedNodes}
            SET n:DeletedVNode
            REMOVE n:VNode
            RETURN NULL
        `);

        const modifiedNodes = new Set<VNID>();
        changes.createdNodes.forEach(cn => modifiedNodes.add(cn.id));
        changes.createdRelationships.forEach(cr => modifiedNodes.add(cr.from));
        changes.deletedRelationships.forEach(dr => modifiedNodes.add(dr.from));
        changes.modifiedNodes.forEach(mn => modifiedNodes.add(mn.id));
        changes.softDeletedNodes.forEach(vnid => modifiedNodes.add(vnid));
        changes.unDeletedNodes.forEach(vnid => modifiedNodes.add(vnid));

        return {resultData: {}, modifiedNodes: Array.from(modifiedNodes)};
    },
    invert: (data, resultData) => null,
});
