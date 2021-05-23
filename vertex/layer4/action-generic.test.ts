import { suite, test, assertRejects, configureTestData, assert, log, before, after } from "../lib/intern-tests";
import {
    Action,
    UndoAction,
} from "..";
import { CreateMovie, CreateMovieFranchise, Movie, MovieFranchise, testGraph, UpdateMovie } from "../test-project";
import { AssertEqual, checkType } from "../lib/ts-utils";

suite(__filename, () => {

    configureTestData({isolateTestWrites: true, loadTestProjectData: false});

    suite("UndoAction", () => {

        test("has a statically typed 'type'", () => {
            checkType<AssertEqual<typeof UndoAction.type, "UndoAction">>();
        });

        suite("basic tests", () => {
            const action1 = CreateMovieFranchise({slugId: "mcu", name: "Marvel Cinematic Universe"});
            const action2 = CreateMovie({slugId: "guardians-galaxy", title: "Guardians of the Galaxy", year: 2014, franchiseId: "mcu"});
            // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
            const checkData = async () => ({
                franchise: await testGraph.pull(MovieFranchise, mf => mf.slugId.name),
                movie: await testGraph.pull(Movie, m => m.title.year.franchise(f=>f.slugId)),
            });
            const expectedAfter0 = {
                franchise: [],
                movie: [],
            };
            const expectedAfter1 = {
                franchise: [{ slugId: "mcu", name: "Marvel Cinematic Universe"}],
                movie: [],
            };
            const expectedAfter1and2 = {
                franchise: [{ slugId: "mcu", name: "Marvel Cinematic Universe"}],
                movie: [{ title: "Guardians of the Galaxy", year: 2014, franchise: { slugId: "mcu" } }],
            };

            test("It can undo actions", async () => {
                const result1 = await testGraph.runAsSystem(action1);
                assert.deepStrictEqual(await checkData(), expectedAfter1);
                const result2 = await testGraph.runAsSystem(action2);
                assert.deepStrictEqual(await checkData(), expectedAfter1and2);

                // Now undo action2:
                const undo2 = await testGraph.runAsSystem(UndoAction({actionId: result2.actionId}));
                assert.deepStrictEqual(await checkData(), expectedAfter1);
                // Now undo action1:
                const undo1 = await testGraph.runAsSystem(UndoAction({actionId: result1.actionId}));
                assert.deepStrictEqual(await checkData(), expectedAfter0);
            });

            test("It marks actions as reverted when undone", async () => {
                const result1 = await testGraph.runAsSystem(action1);
                const result2 = await testGraph.runAsSystem(action2);
                assert.deepStrictEqual(
                    // action 2 is not marked as reverted:
                    await testGraph.pullOne(Action, a => a.revertedBy(a=>a.id), {key: result2.actionId}),
                    {revertedBy: null},
                );

                // Now undo action2:
                const undo2 = await testGraph.runAsSystem(UndoAction({actionId: result2.actionId}));
                assert.deepStrictEqual(await checkData(), expectedAfter1);

                // Now action2 should be marked as reverted:
                assert.deepStrictEqual(
                    // action 2 is not marked as reverted:
                    await testGraph.pullOne(Action, a => a.revertedBy(a=>a.id), {key: result2.actionId}),
                    {revertedBy: {id: undo2.actionId}},
                );
            });

            test("It won't let an action be undone twice", async () => {
                const result1 = await testGraph.runAsSystem(action1);
                const result2 = await testGraph.runAsSystem(action2);
                const undo2 = await testGraph.runAsSystem(UndoAction({actionId: result2.actionId}));
                assert.deepStrictEqual(await checkData(), expectedAfter1);
                await assertRejects(
                    testGraph.runAsSystem(UndoAction({actionId: result2.actionId})),
                    "That action was already undone.",
                );
            });

            test("It can undo an undo [and undo that, and undo that...]", async () => {
                const result1 = await testGraph.runAsSystem(action1);
                    const result2 = await testGraph.runAsSystem(action2);
                        const undo2 = await testGraph.runAsSystem(UndoAction({actionId: result2.actionId}));
                    assert.deepStrictEqual(await checkData(), expectedAfter1);
                    const undo1 = await testGraph.runAsSystem(UndoAction({actionId: result1.actionId}));
                assert.deepStrictEqual(await checkData(), expectedAfter0);
                    const redo1 = await testGraph.runAsSystem(UndoAction({actionId: undo1.actionId}));
                    assert.deepStrictEqual(await checkData(), expectedAfter1);
                    const redo2 = await testGraph.runAsSystem(UndoAction({actionId: undo2.actionId}));
                        assert.deepStrictEqual(await checkData(), expectedAfter1and2);
                        const undoRedo2 = await testGraph.runAsSystem(UndoAction({actionId: redo2.actionId}));
                    assert.deepStrictEqual(await checkData(), expectedAfter1);
            });

            test("It won't undo an action if there is a conflict", async () => {
                const result1 = await testGraph.runAsSystem(action1);
                const result2 = await testGraph.runAsSystem(action2);

                // Set the franchise to NULL
                await testGraph.runAsSystem(UpdateMovie({key: "guardians-galaxy", franchiseId: null}));
                // Now try to undo action2. It should fail because it tries to undo the franchise being set to "mcu"
                await assertRejects(
                    testGraph.runAsSystem(UndoAction({actionId: result2.actionId})),
                    "One of the relationships created by that action cannot be deleted; cannot undo.",
                );
            });
        });
    });
});