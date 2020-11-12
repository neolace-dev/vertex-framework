/**
 * A standard data request (BaseDataRequest) only allows specifying raw properties of a VNode.
 * These mixins extend the standard data request, so that one can request "virtual properties" (like related nodes),
 *  _conditionally_ request raw properties, and other things.
 *
 * This file contains the TypeScript types for the mixins, and a separate file contains their actual runtime
 * implementation, which is quite different. So the types in this file are a bit of a fake facade that provides a nice
 * developer experience and type checking in the IDE, but don't exactly match how things are implemented underneath.
 */

import Joi from "@hapi/joi";
import { FieldType } from "../layer2/cypher-return-shape";
import { VNodeRelationship, BaseVNodeType } from "../layer2/vnode-base";
import { BaseDataRequest, UpdateMixin } from "../layer3/data-request";
import { VirtualCypherExpressionProperty, VirtualManyRelationshipProperty, VirtualOneRelationshipProperty } from "./virtual-props";
import { VNodeType, VNodeTypeWithVirtualProps } from "./vnode";
import type { DerivedProperty } from "./derived-props";

///////////////// ConditionalRawPropsMixin /////////////////////////////////////////////////////////////////////////////

/** Allow requesting raw properties conditionally, based on whether or not a "flag" is set: */
export type ConditionalRawPropsMixin<
    VNT extends BaseVNodeType,
    conditionallyRequestedProperties extends keyof VNT["properties"] = never,
> = ({
    [propName in keyof VNT["properties"] as `${string & propName}IfFlag`]:
        <ThisRequest>(this: ThisRequest, flagName: string) => (
            UpdateMixin<VNT, ThisRequest,
                // Change this mixin from:
                ConditionalRawPropsMixin<VNT, conditionallyRequestedProperties>,
                // to:
                ConditionalRawPropsMixin<VNT, conditionallyRequestedProperties | propName>
            >
        )
});

///////////////// VirtualPropsMixin ////////////////////////////////////////////////////////////////////////////////////

/** Allow requesting virtual properties, optionally based on whether or not a flag is set */
export type VirtualPropsMixin<
    VNT extends VNodeTypeWithVirtualProps,
    includedVirtualProps extends RecursiveVirtualPropRequest<VNT>|unknown = unknown,
> = ({
    [propName in keyof VNT["virtualProperties"]]://Omit<VNT["virtualProperties"], keyof includedVirtualProps>]:
        VNT["virtualProperties"][propName] extends VirtualManyRelationshipProperty ?
            // For each x:many virtual property, add a method for requesting that virtual property:
            <ThisRequest, SubSpec extends BaseDataRequest<VNT["virtualProperties"][propName]["target"], any, any>, FlagType extends string|undefined = undefined>
            // This is the method:
            (this: ThisRequest,
                subRequest: (buildSubrequest: BaseDataRequest<VNT["virtualProperties"][propName]["target"], never, ResetMixins<ThisRequest, VNT["virtualProperties"][propName]["target"] & ProjectRelationshipProps<VNT["virtualProperties"][propName]["relationship"]> >>) => SubSpec,
                options?: {ifFlag?: FlagType}
            ) => (
                UpdateMixin<VNT, ThisRequest,
                    VirtualPropsMixin<VNT, includedVirtualProps>,
                    VirtualPropsMixin<VNT, includedVirtualProps & {
                        [PN in propName]: {ifFlag: FlagType, spec: SubSpec, type: "many"}
                    }>
                >
            )

        : VNT["virtualProperties"][propName] extends VirtualOneRelationshipProperty ?
            // For each x:one virtual property, add a method for requesting that virtual property:
            <ThisRequest, SubSpec extends BaseDataRequest<VNT["virtualProperties"][propName]["target"], any, any>, FlagType extends string|undefined = undefined>
            (this: ThisRequest, subRequest: (buildSubequest: BaseDataRequest<VNT["virtualProperties"][propName]["target"], never, ResetMixins<ThisRequest, VNT["virtualProperties"][propName]["target"]>>) => SubSpec, options?: {ifFlag: FlagType}) => (
                UpdateMixin<VNT, ThisRequest,
                    VirtualPropsMixin<VNT, includedVirtualProps>,
                    VirtualPropsMixin<VNT, includedVirtualProps & {
                        [PN in propName]: {ifFlag: FlagType, spec: SubSpec, type: "one"}
                    }>
                >
            )

        : VNT["virtualProperties"][propName] extends VirtualCypherExpressionProperty ?
            // Add a method to include this [virtual property based on a cypher expression], optionally toggled via a flag:
            <ThisRequest, FlagType extends string|undefined = undefined>
            (this: ThisRequest, options?: {ifFlag: FlagType}) => (
                UpdateMixin<VNT, ThisRequest,
                    VirtualPropsMixin<VNT, includedVirtualProps>,
                    VirtualPropsMixin<VNT, includedVirtualProps & {
                        [PN in propName]: {ifFlag: FlagType, type: "cypher", valueType: VNT["virtualProperties"][propName]["valueType"]}
                    }>
                >
            )
        : never
});

/** Type data about virtual properties that have been requested so far in a VNodeDataRequest */
type RecursiveVirtualPropRequest<VNT extends VNodeTypeWithVirtualProps> = {
    [K in keyof VNT["virtualProperties"]]?: (
        VNT["virtualProperties"][K] extends VirtualManyRelationshipProperty ?
            IncludedVirtualManyProp<VNT["virtualProperties"][K], any> :
        VNT["virtualProperties"][K] extends VirtualOneRelationshipProperty ?
            IncludedVirtualOneProp<VNT["virtualProperties"][K], any> :
        VNT["virtualProperties"][K] extends VirtualCypherExpressionProperty ?
            IncludedVirtualCypherExpressionProp<VNT["virtualProperties"][K]["valueType"]> :
        never
    )
}

export type IncludedVirtualManyProp<propType extends VirtualManyRelationshipProperty, Spec extends BaseDataRequest<propType["target"], any, any>> = {
    ifFlag: string|undefined,
    spec: Spec,
    type: "many",  // This field doesn't really exist; it's just a hint to the type system so it can distinguish among the RecursiveVirtualPropRequest types
};

export type IncludedVirtualOneProp<propType extends VirtualOneRelationshipProperty, Spec extends BaseDataRequest<propType["target"], any, any>> = {
    ifFlag: string|undefined,
    spec: Spec,
    type: "one",  // This field doesn't really exist; it's just a hint to the type system so it can distinguish among the RecursiveVirtualPropRequest types
};

export type IncludedVirtualCypherExpressionProp<FT extends FieldType> = {
    ifFlag: string|undefined,
    type: "cypher",  // This field doesn't really exist; it's just a hint to the type system so it can distinguish among the RecursiveVirtualPropRequest types
    valueType: FT;  // This field also doesn't exist, but is required for type inference to work
};

// When using a virtual property to join some other VNode to another node, this ProjectRelationshipProps type is used to
// "project" properties from the *relationship* so that they appear as virtual properties on the target VNode.
//
// For example, if there is a (:Person)-[:ACTED_IN]->(:Movie) where "Person" is the main VNode and "Person.movies" is a
// virtual property to list the movies they acted in, and the ACTED_IN relationship has a "role" property, then this is
// used to make the "role" property appear as a virtual property on the Movie VNode.
type ProjectRelationshipProps<Rel extends VNodeRelationship|undefined> = (
    Rel extends VNodeRelationship ? {
        virtualProperties: {
            [K in keyof Rel["properties"]]: VirtualCypherExpressionPropertyForRelationshipProp<Rel["properties"][K]>
        }
    } : unknown
);
type VirtualCypherExpressionPropertyForRelationshipProp<Prop> = (
    // This is a generated VirtualCypherExpressionProperty, used to make a property from the relationship appear as an
    // available virtual property on the target VNode. (e.g. the "role" property from the ACTED_IN relationship now
    // appears as a VirtualCypherExpressionProperty on the Movie VNode when accessed via the "person.movies.role"
    // virtual property, even though there is normally no "movies.role" virtual property.)
    Omit<VirtualCypherExpressionProperty, "valueType"> & {
        // We don't really enforce relationship properties or know when they're nullable so assume they can always be null:
        valueType: {nullOr: (
            // "Prop" is the property definition (Joi validator) defined in the VNode.relationshipsFrom section
            Prop extends Joi.StringSchema ? "string" :
            Prop extends Joi.NumberSchema ? "number" :
            Prop extends Joi.BooleanSchema ? "boolean" :
            Prop extends Joi.DateSchema ? "string" :
            "any"
        )}
    }
);

///////////////// DerivedPropsMixin ////////////////////////////////////////////////////////////////////////////////////

/** Allow requesting derived properties, optionally based on whether or not a flag is set */
export type DerivedPropsMixin<
    VNT extends VNodeType,
    includedDerivedProps extends DerivedPropRequest<VNT>|unknown = unknown,
> = ({
    [propName in keyof VNT["derivedProperties"]]:
        // For each derived property, add a method for requesting that derived property:
        <ThisRequest, FlagType extends string|undefined = undefined>
        (this: ThisRequest, options?: {ifFlag?: FlagType}) => (
            UpdateMixin<VNT, ThisRequest,
                DerivedPropsMixin<VNT, includedDerivedProps>,
                DerivedPropsMixin<VNT, includedDerivedProps & { [PN in propName]: {
                    ifFlag: FlagType,
                    valueType: GetDerivedPropValueType<VNT["derivedProperties"][propName]>,
                } }>
            >
        )
});

/** Type data about derived properties that have been requested so far in a VNodeDataRequest */
type DerivedPropRequest<VNT extends VNodeType> = {
    [K in keyof VNT["derivedProperties"]]?: IncludedDerivedPropRequest<any>;
}

export type IncludedDerivedPropRequest<ValueType> = {
    ifFlag: string|undefined,
    valueType: ValueType,
};

type GetDerivedPropValueType<DerivedProp extends DerivedProperty<any>> = (
    DerivedProp extends DerivedProperty<infer ValueType> ? ValueType : any
);

///////////////// ResetMixins //////////////////////////////////////////////////////////////////////////////////////////


// The mixin types contain type information about specific selected properties. When creating a recursive request for
// virtual properties (e.g. to select which fields to include for the target of one-to-many relationship), it's
// necessary to incude the same mixins, but with a different VNodeType specified and the data about which fields are
// included reset.
type ResetMixins<Request extends BaseDataRequest<any, any, any>, newVNodeType extends BaseVNodeType> = (
    Request extends BaseDataRequest<any, any, infer Mixins> ? (
        ResetMixins1<Mixins, unknown, newVNodeType>
    ) : never
);

type ResetMixins1<OldMixins, NewMixins, newVNodeType extends BaseVNodeType> = (
    ResetMixins2<OldMixins, 
        OldMixins extends ConditionalRawPropsMixin<any, any> ?
            NewMixins & ConditionalRawPropsMixin<newVNodeType>
        : NewMixins
    , newVNodeType>
);

type ResetMixins2<OldMixins, NewMixins, newVNodeType extends BaseVNodeType> = (
    ResetMixins3<OldMixins,
        OldMixins extends VirtualPropsMixin<any, any> ?
            NewMixins & (
                newVNodeType extends VNodeTypeWithVirtualProps ?
                    VirtualPropsMixin<newVNodeType>
                : unknown
            )
        : NewMixins
    , newVNodeType>
);


type ResetMixins3<OldMixins, NewMixins, newVNodeType extends BaseVNodeType> = (
    OldMixins extends DerivedPropsMixin<any, any> ?
        NewMixins & (
            newVNodeType extends VNodeType ?
                DerivedPropsMixin<newVNodeType>
            : unknown
        )
    : NewMixins
);
