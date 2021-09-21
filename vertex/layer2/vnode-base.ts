import { WrappedTransaction } from "../transaction.ts";
import { Field, FieldType, GetDataShape, PropSchema, validatePropSchema, PropertyTypedField } from "../lib/types/field.ts";
import { C } from "./cypher-sugar.ts";
import { convertNeo4jFieldValue } from "./cypher-return-shape.ts";
import { VNID } from "../lib/key.ts";
import { applyLazilyToDeferrable, deferrable, Deferrable } from "../lib/deferrable.ts";

// An empty object that can be used as a default value for read-only properties
export const emptyObj = Object.freeze({});
// A private key used to store relationship types (labels) on their declarations
const relTypeKey = Symbol("relTypeKey");

export interface PropSchemaWithId extends PropSchema {
    id: PropertyTypedField<FieldType.VNID, false>;
}

export interface RelationshipsSchema {
    [RelName: string]: RelationshipDeclaration;
}
/** Interface used to declare each relationship that can come *from* this VNodeType to other VNodes */
export interface RelationshipDeclaration {
    /**
     * This relationship is allowed to point _to_ VNodes of these types.
     * Use [VNodeType] itself to mean "Any VNodeType"
     */
    to: ReadonlyArray<{new(): _BaseVNodeType;label: string}>; // Would prefer to use ReadonlyArray<BaseVNodeType>, but it causes circular type issues when used with the hasRelationshipsFromThisTo helper function
    /** The properties that are expected/allowed on this relationship */
    properties?: Readonly<PropSchema>;
    /** Cardinality: set restrictions on how many nodes this relationship can point to. */
    cardinality?: Cardinality,
    // A private key used to store relationship types (labels) on their declarations. Set by the @VNode.declare decorator.
    [relTypeKey]?: string;
}
export enum Cardinality {
    /** This relationship points to a single target node and it must be present. */
    ToOneRequired = ":1",
    /** This relationship points to a single target node if it exists, but the relationship may not exist. */
    ToOneOrNone = ":0-1",
    /**
     * ToMany: This relationshipship can point to any number of nodes, including to the same node multiple times.
     * This is the default, which is the same as having no restrictions on cardinality.
     */
    ToMany = ":*",
    /** This relationship can point to many nodes, but cannot point to the same node multiple times */
    ToManyUnique = ":*u",
}

/**
 * Base class for a "VNode".
 * A VNode is a node in the Neo4j graph that follows certain rules:
 *   - Every VNode is uniquely identified by a VNID
 *   - Every VNode optionally has a "slugId" string key; the slugId can be changed but previously used slugIds
 *     continue to point to the same VNode.
 *   - VNodes can only be modified (mutated) via "Actions", which are recorded via an Action VNode in the graph.
 *   - Each VNode is an instance of one or more VNode types ("labels" in Neo4j), which enforce a strict schema of
 *     properties and relationships
 *
 * This class is not exposed directly in the public API for Vertex Framework. Instead, use the VNodeType class declared
 * in layer 4.
 */
export class _BaseVNodeType {
    public constructor() { throw new Error("VNodeType should never be instantiated. Use it statically only."); }
    static label = "VNode";
    /** If this type has a slugId property, this is the prefix that all of its slugIds must have (e.g. "user-") */
    static readonly slugIdPrefix: string = "";
    static readonly properties: PropSchemaWithId = {
        id: Field.VNID,
    };
    /** Relationships allowed/available _from_ this VNode type to other VNodes */
    static readonly rel: RelationshipsSchema = emptyObj;
    /** When pull()ing data of this type, what field should it be sorted by? e.g. "name" or "name DESC" */
    static readonly defaultOrderBy: string|undefined = undefined;

    // deno-lint-ignore no-explicit-any
    static async validate(dbObject: RawVNode<any>, tx: WrappedTransaction): Promise<void> {
        // Note: tests for this function are in layer3/validation.test.ts since they depend on actions

        // Validate slugId prefix
        if (this.slugIdPrefix !== "") {
            if (!this.properties.slugId) {
                throw new Error("A VNodeType cannot specify a slugIdPrefix if it doesn't declare the slugId property");
            }
            if (typeof dbObject.slugId !== "string" || !dbObject.slugId.startsWith(this.slugIdPrefix)) {
                throw new ValidationError(`${this.label} has an invalid slugId "${dbObject.slugId}". Expected it to start with "${this.slugIdPrefix}".`);
            }
        }

        // Validate properties:
        const newValues = validatePropSchema(this.properties, dbObject);

        // Check if the validation cleaned/changed any of the values:
        const valuesChangedDuringValidation: Record<string, unknown> = {}
        for (const key in newValues) {
            if (newValues[key] !== dbObject[key]) {
                valuesChangedDuringValidation[key] = newValues[key];
            }
        }
        if (Object.keys(valuesChangedDuringValidation).length > 0) {
            await tx.queryOne(C`
                MATCH (node:VNode {id: ${dbObject.id}})
                SET node += ${valuesChangedDuringValidation}
            `.RETURN({}));
        }

        // Validate relationships:
        const relTypes = Object.keys(this.rel);
        if (relTypes.length > 0) {
            // Storing large amounts of data on relationship properties is not recommended so it should be safe to pull
            // down all the relationships and their properties.
            const relData = await tx.query(C`
                MATCH (node:VNode {id: ${dbObject.id}})-[rel]->(target:VNode)
                RETURN type(rel) as relType, properties(rel) as relProps, labels(target) as targetLabels, id(target) as targetId
            `.givesShape({relType: Field.String, relProps: Field.Any, targetLabels: Field.List(Field.String), targetId: Field.Int}));
            // Check each relationship type, one type at a time:
            for (const relType of relTypes) {
                const spec = this.rel[relType];
                const rels = relData.filter(r => r.relType === relType);
                // Check the target labels, if they are restricted:
                if (spec.to !== undefined) {
                    // Every node that this relationship points to must have at least one of the allowed labels
                    // This should work correctly with inheritance
                    const allowedLabels = spec.to.map(vnt => vnt.label);
                    rels.forEach(r => {
                        if (!allowedLabels.find(allowedLabel => r.targetLabels.includes(allowedLabel))) {
                            throw new ValidationError(`Relationship ${relType} is not allowed to point to node with labels :${r.targetLabels.join(":")}`);
                        }
                    });
                }
                // Check the cardinality of this relationship type, if restricted:
                if (spec.cardinality !== Cardinality.ToMany) {
                    // How many nodes does this relationship type point to:
                    const targetCount = rels.length;
                    if (spec.cardinality === Cardinality.ToOneRequired) {
                        if (targetCount < 1) {
                            throw new ValidationError(`Required relationship type ${relType} must point to one node, but does not exist.`);
                        } else if (targetCount > 1) {
                            throw new ValidationError(`Required to-one relationship type ${relType} is pointing to more than one node.`);
                        }
                    } else if (spec.cardinality === Cardinality.ToOneOrNone) {
                        if (targetCount > 1) {
                            throw new ValidationError(`To-one relationship type ${relType} is pointing to more than one node.`);
                        }
                    } else if (spec.cardinality === Cardinality.ToManyUnique) {
                        const uniqueTargets = new Set(rels.map(r => r.targetId));
                        if (uniqueTargets.size !== targetCount) {
                            throw new ValidationError(`Creating multiple ${relType} relationships between the same pair of nodes is not allowed.`);
                        }
                    }
                }
                // Check the properties, if their schema is specified:
                if (Object.keys(spec.properties ?? emptyObj).length) {
                    rels.forEach(r => {
                        if (spec.properties) {
                            // For consistency, we make missing properties always appear as "null" instead of "undefined":
                            const valuesFound = {...r.relProps};
                            for (const propName in spec.properties) {
                                if (propName in valuesFound) {
                                    valuesFound[propName] = convertNeo4jFieldValue(propName, valuesFound[propName], spec.properties[propName]);
                                } else {
                                    valuesFound[propName] = null;
                                }
                            }
                            validatePropSchema(spec.properties, valuesFound);
                        }
                    });
                }
            }
        }
    }


    /** Helper method needed to declare a VNodeType's "rel" (relationships) property with correct typing and metadata. */
    static hasRelationshipsFromThisTo<Rels extends RelationshipsSchema>(relationships: Deferrable<Rels>): Rels {
        const deferredRels = deferrable(relationships);

        // We need to apply some cleanups and validation and annotation to the .rels property. BUT that property may be
        // "deferred" (wrapped in a proxy object and lazily evaluated when accessed) in order to avoid circular imports.
        // So use this helper function to do the cleanup/validation at the last second, when .rels is first accessed.
        applyLazilyToDeferrable(deferredRels, (rels => {
            // Check for annoying circular references that TypeScript can't catch:
            Object.entries(rels).forEach(([relName, rel]) => {
                rel.to.forEach((targetVNT, idx) => {
                    if (targetVNT === undefined) {
                        throw new Error(`
                            Circular reference in ${this.name} definition: relationship ${this.name}.rel.${relName}.to[${idx}] is undefined.
                            Try putting the relationships into a function, like "static rel = this.hasRelationshipsFromThisTo(() => {...});"
                        `);
                    }
                });
            });

            // Store the "type" (name/label) of each relationship in its definition, so that when parts of the code
            // reference a relationship like SomeVNT.rel.FOO_BAR, we can get the name "FOO_BAR" from that value, even though
            // the name was only declared as the key, and is not part of the FOO_BAR value.
            for (const relationshipType of Object.keys(rels)) {
                storeRelationshipType(relationshipType, rels[relationshipType]);
            }
        }));
        return deferredRels;
    }

    /**
     * Helper function used to embed a reference to a specific VNode in a string
     * e.g. Actions that describe themselves can say something like:
     *      `Changed 'name' of ${Person.withId(result["p1.id"])}`
     * and then if that is displayed somewhere, it can be rendered in a user-friendly way, such as:
     *      `Changed 'name' of <Bob Jones (Person with slugId 'per-bob')>`
     * or in a rich text environment, it can be replaced with a link.
     *
     * Subclasses should NOT override this.
     * 
     * Note that ` is used as a delimiter because when it prints something like this
     *      Created `AstronomicalBody _16L9VRwDGzFZu0HJqtzW2Z`
     * in plain text, one can double-click AstronomicalBody or _16L9VRwDGzFZu0HJqtzW2Z in a text editor to select it,
     * without selecting the delimeter character.
     */
    static withId(id: VNID): string {
        return `\`${this.name} ${id}\``;
    }

    // This method is not used for anything, but without at least one non-static method, TypeScript allows this:
    //     const test: _BaseVNodeType = "some string which is not a VNodeType!";
    protected __vnode(): void {/* */}
    protected static __vnode(): void {/* */}

    // Helpers for declaring relationships:
    static readonly Rel = Cardinality;
}

// This little trick (and the VNodeType interface below) are required so that this class is only used statically,
// never instantiated.
export const BaseVNodeType = _BaseVNodeType;

export interface BaseVNodeType {
    new(): _BaseVNodeType;
    readonly label: string;
    readonly properties: PropSchemaWithId;
    /** Relationships allowed/available _from_ this VNode type to other VNodes */
    readonly rel: RelationshipsSchema;
    readonly defaultOrderBy: string|undefined;
    // deno-lint-ignore no-explicit-any
    validate(dbObject: RawVNode<any>, tx: WrappedTransaction): Promise<void>;

    withId(id: VNID): string;
}

/** Helper function to check if some object is a VNodeType */
export function isBaseVNodeType(obj: unknown): obj is BaseVNodeType {
    return typeof obj === "function" && Object.prototype.isPrototypeOf.call(_BaseVNodeType, obj);
}

/**
 * Store the "type" (name/label) of each relationship in its definition, so that when parts of the code
 * reference a relationship like SomeVNT.rel.FOO_BAR, we can get the name "FOO_BAR" from that value, even though
 * the name was only declared as the key, and is not part of the FOO_BAR value.
 * 
 * This is used in Vertex.registerVNodeType()
 */
export function storeRelationshipType(relationshipType: string, relDeclaration: RelationshipDeclaration) {
    if (relDeclaration[relTypeKey] !== undefined && relDeclaration[relTypeKey] != relationshipType) {
        // This is a very obscure edge case error, but if someone is saying something like
        // rel = { FOO: SomeOtherVNodeType.rel.BAR } then we need to flag that we can't share the same
        // relationship declaration and call it both FOO and BAR.
        throw new Error(`The relationship ${relationshipType} is also declared somewhere else as type ${relDeclaration[relTypeKey]}.`);
    }
    relDeclaration[relTypeKey] = relationshipType;
}

/** Helper function to get the type/name of a relationship from its declaration - see storeRelationshipType() */
export function getRelationshipType(rel: RelationshipDeclaration): string {
    const relDeclaration = rel;
    const result = relDeclaration[relTypeKey];
    if (result === undefined) {
        throw new Error(`A VNodeType's relationships were not declared using this.hasRelationshipsFromThisTo({...})`);
    }
    return result;
}

/**
 * Is the thing passed as a parameter a relationship declaration (that was declared in a VNode's "rel" static prop?)
 * This checks for a private property that gets added to every relationship by storeRelationshipType() during
 * Vertex.registerVNodeType()
 */
export function isRelationshipDeclaration(relDeclaration: unknown): relDeclaration is RelationshipDeclaration {
    // In JavaScript, typeof null === "object" which is why we need the middle condition here.
    return typeof relDeclaration === "object" && relDeclaration !== null && relTypeKey in relDeclaration;
}


/**
 * If a single VNode is loaded from the database (without relationships or virtual properties), this is the shape
 * of the resulting data.
 */
export type RawVNode<T extends BaseVNodeType> = GetDataShape<T["properties"]> & { _labels: string[]; };


/** Exception: A VNode with the specified label has not been registered [via registerVNodeType()]  */
export class InvalidNodeLabel extends Error {}

export function getAllLabels(vnt: BaseVNodeType): string[] {
    if (!vnt.label || vnt.label === "VNode") {
        throw new Error(`VNodeType ${vnt.name} has no valid label.`);
    }
    const labels = [];
    for (let t = vnt; t.label; t = Object.getPrototypeOf(t)) {
        labels.push(t.label);
        if (t.label === "VNode") {
            break;
        }
    }
    return labels;
}

/**
 * A consistency check failure when validating our graph's data.
 * 
 * Use PublicValidationError if the message is safe for end users to see
 * (contains no internal/private data).
 */
export class ValidationError extends Error {}
// /** A validation error that is safe to report publicly. */
export class PublicValidationError extends ValidationError {}
