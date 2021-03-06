import { C } from "../layer2/cypher-sugar.ts";
import { WrappedTransaction } from "../transaction.ts";
import { RelationshipDeclaration, getRelationshipType } from "../layer2/vnode-base.ts";
import { VNodeType } from "../layer3/vnode.ts";
import { stringify } from "../lib/log.ts";
import { VNodeKey, VNID } from "../lib/key.ts";
import { Field, GetDataType, PropSchema } from "../lib/types/field.ts";

export type OneRelationshipSpec<VNR extends RelationshipDeclaration, KeyType = VNodeKey> = {
    key: KeyType|null;
} & (
    VNR["properties"] extends PropSchema ?
        {[propName in keyof VNR["properties"]]?: GetDataType<VNR["properties"][propName]>}
    :
        Record<string, never>/* empty object */
    )

/**
 * Designed for use in an "Update"-type Action, this helper method will update a relationship from the current VNode,
 * pointing to either another VNode or null. (an "x:1" relationship, e.g. "1:1" or "many:1")
 */
export async function updateToOneRelationship<VNR extends RelationshipDeclaration>(tx: WrappedTransaction, {from, rel, to}: {
    from: [vnt: VNodeType, id: VNID],
    rel: VNR,
    to: string|null|OneRelationshipSpec<VNR>,
}): Promise<{prevTo: OneRelationshipSpec<VNR, VNID>}> {
    const [fromType, fromId] = from;
    const relType = getRelationshipType(rel);  // Name of the relationship
    const {toKey, relationshipProps} = (() => {
        if (typeof to === "string" || to === null) {
            return {toKey: to, relationshipProps: {}};
        }
        const {key, ...relationshipProps} = to;
        return {toKey: key, relationshipProps};
    })();

    if (fromType.rel[relType] !== rel) {
        throw new Error(`Mismatch between relationship ${relType} and VNodeType ${fromType.label} which doesn't declare that exact relationship.`);
    }
    const targetLabels = rel.to.map(tn => tn.label);

    if (toKey === null) {
        // We want to clear this x:1 relationship (set it to null)
        // Delete any existing relationship, returning the ID of the target it used to point to, as well as any
        // properties that were set on the relationship
        const delResult = await tx.query(C`
            MATCH (:${fromType} {id: ${fromId}})-[rel:${rel}]->(target:VNode)
            WITH rel, target, properties(rel) as relProps
            DELETE rel
        `.RETURN({"target.id": Field.VNID, relProps: Field.Any}));
        return {prevTo: delResult.length ? {key: delResult[0]["target.id"], ...delResult[0].relProps} : {key: null}};
    } else {
        // We want this x:1 relationship pointing to a specific node, identified by "toKey"

        // This query works in three parts:
        // 1) An OPTIONAL MATCH to get the old relationship(s) and any properties set on it
        // 2) A MERGE and SET to create the new relationship and set its properties
        // 3) An OPTIONAL MATCH to DELETE the old relationship(s)
        const mergeResult = await tx.query(C`
            MATCH (self:${fromType} {id: ${fromId}})
            MATCH (target:VNode), target HAS KEY ${toKey}
            WHERE ${C(targetLabels.map(targetLabel => `target:${targetLabel}`).join(" OR "))}

            WITH self, target
            OPTIONAL MATCH (self)-[oldRel:${rel}]->(oldTarget:VNode)
            WITH self, target, collect(oldTarget {.id, properties: properties(oldRel)}) as oldTargets

            MERGE (self)-[rel:${rel}]->(target)
            SET rel = ${relationshipProps}

            WITH self, target, oldTargets, rel
            OPTIONAL MATCH (self)-[oldRel:${rel}]->(oldTarget:VNode) WHERE oldRel <> rel
            DELETE oldRel

            WITH oldTargets, target
        `.RETURN({"oldTargets": Field.List(Field.Record({id: Field.VNID, properties: Field.Any}))}));
        if (mergeResult.length === 0) {
            // The above query should only fail if the MATCH clauses don't match anything.
            throw new Error(`Cannot change ${fromType.name} relationship ${relType} to "${toKey}" - target not found.`);
        }
        
        if (mergeResult[0].oldTargets.length) {
            return {prevTo: {key: mergeResult[0].oldTargets[0].id, ...mergeResult[0].oldTargets[0].properties}};
        }
        // deno-lint-ignore no-explicit-any
        return {prevTo: {key: null} as any};
    }
}


export type RelationshipSpec<VNR extends RelationshipDeclaration, KeyType = VNodeKey> = {
    key: KeyType;
} & (
    VNR["properties"] extends PropSchema ?
        {[propName in keyof VNR["properties"]]?: GetDataType<VNR["properties"][propName]>}
    :
        Record<string, never>/* empty object */
)

/**
 * Designed for use in an "Update"-type Action, this helper method will update a relationship from the current VNode,
 * pointing to many other another VNodes (a "1:many" or "many:many" relationship).
 * 
 * This method will always "overwrite" the relationship, replacing any existing relationships of the specified type from
 * the "from" node, and resetting their properties to the newly specified ones.
 * 
 * This method does allow multiple relationships of the same type between the same from/to nodes, so for example you
 * could use this method to say both
 *     (Bob)-[:ATE {on: tuesday}]->(Hamburger) and
 *     (Bob)-[:ATE {on: wednesday}]->(Hamburger)
 * If you don't want to allow that, set {cardinality: RelationshipDeclaration.Cardinality.ToManyUnique} on the relationship.
 */
export async function updateToManyRelationship<VNR extends RelationshipDeclaration>(tx: WrappedTransaction, {from, rel, to}: {
    from: [vnt: VNodeType, id: VNID],
    rel: VNR,
    to: RelationshipSpec<VNR>[],
}): Promise<{prevTo: RelationshipSpec<VNR, VNID>[]}> {
    const [fromType, fromId] = from;
    const relType = getRelationshipType(rel);  // Name of the relationship
    if (fromType.rel[relType] !== rel) {
        throw new Error(`Mismatch between relationship ${relType} and VNodeType ${fromType.label} which doesn't declare that exact relationship.`);
    }

    const targetLabels = rel.to.map(tn => tn.label);

    // Query the existing target node(s). (In an "IS_A" relationship, "target" means "parent")
    const relResult = await tx.query(C`
        MATCH (:${fromType} {id: ${fromId}})-[rel:${rel}]->(target:VNode)
        RETURN properties(rel) as oldProps, id(rel) as oldRelId, target.id, target.slugId
    `.givesShape({"oldProps": Field.Any, "oldRelId": Field.BigInt, "target.id": Field.String, "target.slugId": Field.Slug}));
    const prevTo: RelationshipSpec<VNR, VNID>[] = relResult.map(r => ({key: r["target.id"], ...r["oldProps"]}));

    // We'll build a list of all existing relationships, and remove entries from it as we find that they're supposed to be kept
    const existingRelationshipIdsToDelete = new Set<bigint>(relResult.map(e => e.oldRelId));

    // Create relationships to new target nodes(s):
    for (const {key, ...newProps} of to) {
        // TODO: proper deep comparison instead of stringify() here.
        const identicallExistingRelationship = relResult.find(el => (
            (el["target.id"] === key || el["target.slugId"] === key)
            && stringify(el["oldProps"]) === stringify(newProps)
        ));
        if (identicallExistingRelationship) {
            // This relationship already exists. Remove this relationship from our list of relationships to delete:
            existingRelationshipIdsToDelete.delete(identicallExistingRelationship.oldRelId);
        } else {
            // Create this relationship, with the specified properties:
            const result = await tx.query(C`
                MATCH (self:${fromType} {id: ${fromId}})
                MATCH (target), target HAS KEY ${key}
                WHERE ${C(targetLabels.map(targetLabel => `target:${targetLabel}`).join(" OR "))}
                CREATE (self)-[rel:${rel}]->(target)
                SET rel = ${newProps}
            `.RETURN({}));  // Return null, and ensure the query changed one record exactly
            if (result.length !== 1) {
                // The query above will only not return a single row if one of the MATCH clauses failed to match.
                // Which one? Let's give a helpful error message.
                const self = await tx.query(C`MATCH (self:${fromType} {id: ${fromId}})`.RETURN({"self.id": Field.VNID}));
                if (self.length !== 1) {
                    throw new Error(`Cannot set ${relType} relationship from non-existent ${fromType.name} node with VNID ${fromId}`);
                } else {
                    throw new Error(`Cannot set ${relType} relationship to VNode with key "${key}" which doesn't exist or is the wrong type.`);
                }
            }
        }
    }
    if (existingRelationshipIdsToDelete.size > 0) {
        // Delete relationships that we no longer want:
        await tx.query(C`
            MATCH (:${fromType} {id: ${fromId}})-[rel:${rel}]->(:VNode)
            WHERE id(rel) in ${Array.from(existingRelationshipIdsToDelete)}
            DELETE rel
        `);
    }
    return {prevTo};
}
