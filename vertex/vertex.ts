import neo4j, { Driver } from "neo4j-driver";
import { ActionData, ActionResult } from "./action";
import { runAction } from "./action-runner";
import { log } from "./lib/log";
import { UUID } from "./lib/uuid";
import { PullNoTx, PullOneNoTx } from "./pull";
import { migrations as coreMigrations, SYSTEM_UUID } from "./schema";
import { WrappedTransaction, wrapTransaction } from "./transaction";
import { Migration, VertexCore, VertextTestDataSnapshot } from "./vertex-interface";

export interface InitArgs {
    neo4jUrl: string; // e.g. "bolt://neo4j"
    neo4jUser: string; // e.g. "neo4j",
    neo4jPassword: string;
    debugLogging?: boolean;
    extraMigrations: {[name: string]: Migration};
}

export class Vertex implements VertexCore {
    private readonly driver: Driver;
    public readonly migrations: {[name: string]: Migration};

    constructor(config: InitArgs) {
        this.driver = neo4j.driver(
            config.neo4jUrl,
            neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
            { disableLosslessIntegers: true },
        );
        this.migrations = {...coreMigrations, ...config.extraMigrations};
    }

    /** Await this when your application prepares to shut down */
    public async shutdown(): Promise<void> {
        return this.driver.close();
    }

    /**
     * Create a database read transaction, for reading data from the graph DB.
     */
    public async read<T>(code: (tx: WrappedTransaction) => Promise<T>): Promise<T> {
        const session = this.driver.session({defaultAccessMode: "READ"});
        let result: T;
        try {
            result = await session.readTransaction(tx => code(wrapTransaction(tx)));
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            session.close();
        }
        return result;
    }

    /**
     * Read data from the graph, outside of a transaction
     */
    pull: PullNoTx = (arg1: any, ...args: any[]) => this.read(tx => tx.pull(arg1, ...args)) as any;

    /**
     * Read data from the graph, outside of a transaction
     */
    pullOne: PullOneNoTx = (arg1: any, ...args: any[]) => this.read(tx => tx.pullOne(arg1, ...args)) as any;

    /**
     * Run an action (or multiple actions) as the specified user.
     * Returns the result of the last action specified.
     * @param userUuid The UUID of the user running the action
     * @param action The action to run
     * @param otherActions Additional actions to run, if desired.
     */
    public async runAs<T extends ActionData>(userUuid: UUID, action: T, ...otherActions: T[]): Promise<ActionResult<T>> {
        let result: ActionResult<T> = await runAction(this, action, userUuid);
        for (const action of otherActions) {
            result = await runAction(this, action, userUuid);
        }
        return result;
    }

    /**
     * Run an action (or multiple actions) as the "system user".
     * Returns the result of the last action specified.
     * @param action The action to run
     * @param otherActions Additional actions to run, if desired.
     */
    public async runAsSystem<T extends ActionData>(action: T, ...otherActions: T[]): Promise<ActionResult<T>> {
        return this.runAs(SYSTEM_UUID, action, ...otherActions);
    }

    /**
     * Create a database write transaction, for reading and/or writing
     * data to the graph DB. This should only be used from within a schema migration or by action-runner.ts, because
     * writes to the database should only happen via Actions.
     */
    public async _restrictedWrite<T>(code: (tx: WrappedTransaction) => Promise<T>): Promise<T> {
        // Normal flow: create a new write transaction
        const session = this.driver.session({defaultAccessMode: "WRITE"});
        let result: T;
        try {
            result = await session.writeTransaction(tx => code(wrapTransaction(tx)));
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            session.close();
        }
        return result;
    }

    /**
     * Allow code to write to the database without the trackActionChanges trigger.
     *
     * Normally, for any write transaction, the trackActionChanges trigger will check that the
     * write was done alongside the creation of an "Action" node in the database; for schema migrations
     * we don't use Actions, so we need to pause the trigger during migrations or the trigger
     * will throw an exception and prevent the migration transactions from committing.
     */
    public async _restrictedAllowWritesWithoutAction(someCode: () => Promise<any>): Promise<void> {
        try {
            if (await this.isTriggerInstalled("trackActionChanges")) {
                await this._restrictedWrite(tx => tx.run(`CALL apoc.trigger.pause("trackActionChanges")`));
            }
            await someCode();
        } finally {
            // We must check again if the trigger is installed since someCode() may have changed it.
            if (await this.isTriggerInstalled("trackActionChanges")) {
                await this._restrictedWrite(tx => tx.run(`CALL apoc.trigger.resume("trackActionChanges")`));
            }
        }
    }

    /** Helper function to check if a trigger with the given name is installed in the Neo4j database */
    public async isTriggerInstalled(name: string): Promise<boolean> {
        // For some reason, this counts as a write operation?
        const triggers = await this._restrictedWrite(tx => tx.run(`CALL apoc.trigger.list() yield name`));
        return triggers.records.find(x => x.get("name") === name) !== undefined;
    }

    /**
     * Snapshot whatever data is in the graph database, so that after a test runs,
     * the database can be reset to this snapshot.
     * 
     * This is not very efficient and should only be used for testing, and only
     * to snapshot relatively small amounts of data (i.e. any data created by
     * your migrations and/or shared test fixtures.)
     *
     * This assumes that tests will not attempt any schema changes, which
     * should never be done outside of migrations anyways.
     */
    public async snapshotDataForTesting(): Promise<VertextTestDataSnapshot> {
        const result = await this.read(tx => tx.run(`CALL apoc.export.cypher.all(null, {format: "plain"}) YIELD cypherStatements`));
        let cypherSnapshot: string = result.records[0].get("cypherStatements");
        // We only want the data, not the schema, which is fixed:
        cypherSnapshot = cypherSnapshot.replace(/CREATE CONSTRAINT[^;]+;/g, "");
        cypherSnapshot = cypherSnapshot.replace(/CREATE INDEX[^;]+;/g, "");
        return {cypherSnapshot};
    }

    /**
     * Reset the graph database to the specified snapshot. This should only be used
     * for tests. This should be called after each test case, not before, or otherwise
     * the last test that runs will leave its data in the database.
     */
    public async resetDBToSnapshot(snapshot: VertextTestDataSnapshot): Promise<void> {
        await await this._restrictedAllowWritesWithoutAction(async () => {
            // Disable the shortId auto-creation trigger since it'll conflict with the ShortId nodes already in the data snapshot
            await this._restrictedWrite(async tx => {
                await tx.run(`CALL apoc.trigger.pause("createShortIdRelation")`);
            });
            try {
                await this._restrictedWrite(async tx => {
                    await tx.run(`MATCH (n) DETACH DELETE n`);
                    // For some annoying reason, this silently fails:
                    //  await tx.run(`CALL apoc.cypher.runMany($cypher, {})`, {cypher: snapshot.cypherSnapshot});
                    // So we have to split up the statements ourselves and run each one via tx.run()
                    for (const statement of snapshot.cypherSnapshot.split(";\n")) {
                        if (statement.trim() === "") {
                            continue;
                        }
                        // log.warn(statement);
                        await tx.run(statement);
                    }
                });
            } finally {
                await this._restrictedWrite(async tx => {
                    await tx.run(`CALL apoc.trigger.resume("createShortIdRelation")`);
                });
            }
        });
    }
}
