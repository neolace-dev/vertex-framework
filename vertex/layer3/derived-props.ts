// deno-lint-ignore-file no-explicit-any
import type { VNodeType, VNodeTypeWithVirtualProps } from "./vnode.ts";
import type { AnyDataRequest, BaseDataRequest, RequiredMixin } from "../layer2/data-request.ts";
import type { DataResponse } from "./data-response.ts";
import type { VirtualPropsMixin } from "./data-request-mixins.ts";

/**
 * Derived properties are a special type of virtual property which gets computed with the help of some callback function
 * (i.e. computed by JavaScript code), and which have access to values from other raw and virtual properties.
 * 
 * Declare derived properties within a VNodeType class definition like this:
 *     static derivedProperties = this.hasDerivedProperties({
 *         propName,
 *     });
 *
 * Where propName is a function that returns a "DerivedProperty" instance.
 */
export interface DerivedPropsSchema {
    [K: string]: DerivedProperty<any>|((vnt: VNodeType, derivedPropName: string) => DerivedProperty<any>),
}

// The required Vertex.registerVNodeType() and/or the optional VNodeType.hasDerivedProperties method will "clean" the
// by calling any properties that are declared as functions, to convert them to DerivedProperty objects.
export interface DerivedPropsSchemaCleaned {
    [K: string]: DerivedProperty<any>,
}
export type CleanDerivedProps<DPS extends DerivedPropsSchema> = {
    [K in keyof DPS]: (
        DPS[K] extends DerivedProperty<any> ? DPS[K] :
        DPS[K] extends (vnt: VNodeType, derivedPropName: string) => infer DPType ? DPType
        : any
    )
};


export interface DerivedPropertyFactory {
    <VNT extends VNodeTypeWithVirtualProps, Request extends AnyDataRequest<VNT>, ValueType>(
        appliesTo: VNT,
        dataSpec: (rq: BaseDataRequest<VNT, never, RequiredMixin & VirtualPropsMixin<VNT>>) => Request,
        computeValue: (data: DataResponse<Request>) => ValueType,
    ): DerivedProperty<ValueType>;
}

export class DerivedProperty<ValueType> {
    readonly dataSpec: (rq: BaseDataRequest<any, never, any>) => AnyDataRequest<any>;
    readonly computeValue: (data: any) => ValueType;
    readonly vnt: VNodeTypeWithVirtualProps;

    private constructor(
        vnt: VNodeTypeWithVirtualProps,
        dataSpec: (rq: BaseDataRequest<any, never, any>) => AnyDataRequest<any>,
        computeValue: (data: any) => ValueType
    ) {
        this.vnt = vnt;
        this.dataSpec = dataSpec;
        this.computeValue = computeValue;
    }

    static make: DerivedPropertyFactory = (appliesTo, dataSpec, computeValue) => {
        return new DerivedProperty<ReturnType<typeof computeValue>>(appliesTo, dataSpec, computeValue);
    };
}
