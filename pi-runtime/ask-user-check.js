import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import { createEventBus, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  ExtensionUiBridge,
  findRpivAskUserQuestionTool,
  RPIV_ASK_USER_QUESTION_PACKAGE,
} from "./extension-ui.js";

const packageDir = process.env.PI_ASK_USER_QUESTION_PACKAGE
  ?? path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-ask-user-question");
try {
  await access(path.join(packageDir, "index.ts"));
} catch {
  console.log("SKIP: @juicesharp/rpiv-ask-user-question is not installed in Pi's package store");
  process.exit(0);
}

const loaded = await loadExtensions([path.join(packageDir, "index.ts")], process.cwd(),
  createEventBus(), createExtensionRuntime());
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const definition = extension.tools.get("ask_user_question")?.definition;
assert(definition, "the real package registered ask_user_question");
const recognized = await findRpivAskUserQuestionTool([{
  name:"ask_user_question",
  sourceInfo:{ source:`npm:${RPIV_ASK_USER_QUESTION_PACKAGE}`, origin:"package",
    baseDir:packageDir, path:path.join(packageDir, "index.ts") },
}]);
assert(recognized, "the package identity check accepts the real package directory");
assert.equal(await findRpivAskUserQuestionTool([{
  name:"ask_user_question",
  sourceInfo:{ source:`npm:${RPIV_ASK_USER_QUESTION_PACKAGE}`, origin:"top-level",
    baseDir:packageDir, path:path.join(packageDir, "index.ts") },
}]), undefined, "a top-level same-name tool is not patched");

const bridge = new ExtensionUiBridge();
let state = bridge.snapshot();
bridge.subscribe((next) => { state = next; });
const context = {
  cwd:process.cwd(), hasUI:true, mode:"print", ui:bridge.ui,
  isProjectTrusted:() => true,
};
const execute = (id, params, signal = new AbortController().signal) => bridge.runAskUserQuestion(
  params, signal, () => definition.execute(id, params, signal, () => {}, context));
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("questionnaire state timeout");
};
const params = {
  questions:[{
    question:"Choose\r an approach?",
    header:"Approach",
    options:[
      { label:"Safe", description:"Conservative\r\nchoice", preview:"## Safe\r\nTrusted\rpreview" },
      { label:"Fast", description:"Quick choice" },
    ],
  }, {
    question:"Which extras?",
    header:"Extras",
    multiSelect:true,
    options:[
      { label:"Tests", description:"Add tests" },
      { label:"Docs", description:"Add docs" },
    ],
  }],
};

const submitted = execute("submit", params);
await waitFor((current) => current.askUser?.questions.length === 2);
const firstId = state.askUser.id;
assert.equal(state.askUser.questions[0].question, "Choose an approach?");
assert.equal(state.askUser.questions[0].options[0].description, "Conservative\nchoice");
assert.equal(state.askUser.questions[0].options[0].preview, "## Safe\nTrustedpreview");
assert.throws(() => bridge.replyAskUserQuestion(firstId, {
  answers:[{ questionIndex:0, kind:"option", answer:"Injected" }],
}), /单选答案无效/);
bridge.replyAskUserQuestion(firstId, { answers:[
  { questionIndex:1, kind:"multi", selected:["Tests", "Docs"] },
  { questionIndex:0, kind:"option", answer:"Safe", notes:"  stable  ", preview:"forged" },
], globalNote:"  proceed  " });
assert.throws(() => bridge.cancelAskUserQuestion(firstId), /已失效/);
const answerResult = await submitted;
assert.match(answerResult.content[0].text, /^User has answered your questions:/);
assert.match(answerResult.content[0].text, /selected preview: ## Safe\nTrustedpreview/);
assert.deepEqual(answerResult.details, {
  answers:[
    { questionIndex:0, question:"Choose an approach?", kind:"option", answer:"Safe",
      notes:"stable", preview:"## Safe\nTrustedpreview" },
    { questionIndex:1, question:"Which extras?", kind:"multi", answer:null, selected:["Tests", "Docs"] },
  ],
  cancelled:false,
  globalNote:"proceed",
});
await waitFor((current) => current.askUser === null);

const cancelled = execute("cancel", params);
await waitFor((current) => current.askUser !== null);
bridge.cancelAskUserQuestion(state.askUser.id);
const cancelResult = await cancelled;
assert.equal(cancelResult.content[0].text, "User declined to answer questions");
assert.deepEqual(cancelResult.details, { answers:[], cancelled:true });

const abortController = new AbortController();
const aborted = execute("abort", params, abortController.signal);
await waitFor((current) => current.askUser !== null);
abortController.abort(new Error("fixture abort"));
await assert.rejects(aborted, /fixture abort/);
await waitFor((current) => current.askUser === null);
bridge.dispose();
console.log("PASS: real rpiv ask tool submit/cancel envelope, previews, normalization, stale validation and abort cleanup");
