// Copied from https://deno.land/x/hooked@v0.1.0/mod.ts
// With a bugfix to wrap the inner test case in a try {} finally {}
// The author's other similar JS libraries are MIT licensed so presumably this one is too.
interface Hooks {
    beforeAll: Array<() => void | Promise<void>>;
    beforeEach: Array<() => void | Promise<void>>;
    afterEach: Array<() => void | Promise<void>>;
    afterAll: Array<() => void | Promise<void>>;
    
    waitingTests: number;
    completedTests: number;
    
    onlyTests: number;
    completedOnlyTests: number;
}

interface StackItem extends Hooks {
    name: string;
}

interface GlobalContext extends Hooks {
    stack: StackItem[];
}

const globalContext: GlobalContext = {
    stack: [],
    
    beforeAll: [],
    beforeEach: [],
    afterEach: [],
    afterAll: [],
    
    waitingTests: 0,
    completedTests: 0,
    
    onlyTests: 0,
    completedOnlyTests: 0,
};

function badArgs(): never {
    throw new Error("Invalid test definition");
}

async function callAll(fns: Array<() => void | Promise<void>>): Promise<void> {
    await Promise.all(fns.map((fn) => fn()));
}

/**
* Registers a test for `deno test` while including grouping and hooks.
*/
export function test(t: Deno.TestDefinition): void;
/**
* Registers a test for `deno test` while including grouping and hooks.
*/
export function test(name: string, fn: () => void | Promise<void>): void;
export function test(
    t: Deno.TestDefinition | string,
    testFn?: () => void | Promise<void>,
): void {
    // Extract args
    const { name: testName, fn, ...opts } = typeof t === "object"
        ? t
        : (typeof testFn !== "undefined" ? { name: t, fn: testFn } : badArgs());
    
    // Set up waiting count.
    if (!opts.ignore) {
        globalContext.waitingTests++;
        globalContext.stack.map((name) => name.waitingTests++);
    }
    
    if (opts.only) {
        globalContext.onlyTests++;
        globalContext.stack.map((name) => name.onlyTests++);
    }
    
    // Generate name.
    const name = globalContext.stack.map(({ name: n }) => n);
    name.push(testName);
    
    // Build hook stack.
    const hooks: Hooks[] = [globalContext, ...globalContext.stack];
    const revHooks: Hooks[] = [...hooks].reverse();
    
    Deno.test({
        name: name.join(" > "),
        async fn(t) {
            // Before.
            await t.step("before", async () => {
                for (const { beforeAll, beforeEach, completedTests } of hooks) {
                    if (completedTests === 0) {
                        await callAll(beforeAll);
                    }
                    
                    await callAll(beforeEach);
                }
            })
            
            // Test.
            let succeeded = false;
            try {
                await fn(t);
                succeeded = true;
            } finally {
                for (const hook of hooks) {
                    hook.completedTests++;
                    
                    if (opts.only) {
                        hook.completedOnlyTests++;
                    }
                }
            }

            const doAfter = async () => {
                for (
                    const {
                        afterAll,
                        afterEach,
                        waitingTests,
                        completedTests,
                        onlyTests,
                        completedOnlyTests,
                    } of revHooks
                ) {
                    await callAll(afterEach);
                        
                    if (
                        waitingTests === completedTests ||
                        (onlyTests > 0 && onlyTests === completedOnlyTests)
                    ) {
                        await callAll(afterAll);
                    }
                }
            };

            if (succeeded) {
                await t.step("after", doAfter);
            } else {
                await doAfter(); // Can't do it in a step since steps will be skipped after a failure.
            }
        },
        ...opts,
    });
}
        
        /**
        * Creates an environment in which all tests and hooks are grouped together.
        */
        export function group(name: string, fn: () => void): void {
            globalContext.stack.push({
                name,
                
                beforeAll: [],
                beforeEach: [],
                afterEach: [],
                afterAll: [],
                
                waitingTests: 0,
                completedTests: 0,
                
                onlyTests: 0,
                completedOnlyTests: 0,
            });
            
            fn();
            
            globalContext.stack.pop();
        }
        
        function getTopHooks(): Hooks {
            if (globalContext.stack.length > 0) {
                return globalContext.stack[globalContext.stack.length - 1];
            } else {
                return globalContext;
            }
        }
        
        /**
        * Adds a function to be called before all tests are run.
        */
        export function beforeAll(fn: () => void | Promise<void>): void {
            getTopHooks().beforeAll.push(fn);
        }
        
        /**
        * Adds a function to be called before each test runs.
        */
        export function beforeEach(fn: () => void | Promise<void>): void {
            getTopHooks().beforeEach.push(fn);
        }
        
        /**
        * Adds a function to be called after each test runs.
        */
        export function afterEach(fn: () => void | Promise<void>): void {
            getTopHooks().afterEach.push(fn);
        }
        
        /**
        * Adds a function to be called after all tests have run.
        */
        export function afterAll(fn: () => void | Promise<void>): void {
            getTopHooks().afterAll.push(fn);
        }
            