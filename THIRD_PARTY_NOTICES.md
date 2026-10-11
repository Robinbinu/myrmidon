# Third-party notices

Myrmidon is Apache-2.0 (see LICENSE). Parts of it are ported from the projects below; their notices follow.

## Pipecat

The cloud voice provider adapters and realtime adapters in `packages/runtime/src/voice/cloud/` and
`packages/runtime/src/voice/realtime/` follow the structure of Pipecat's speech services
(https://github.com/pipecat-ai/pipecat), ported to TypeScript.

```
BSD 2-Clause License

Copyright (c) 2024–2026, Daily

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## LiveKit Agents

The Azure and Fish Audio text-to-speech adapters follow LiveKit Agents' plugins
(https://github.com/livekit/agents), Apache License 2.0:

```
Copyright 2023 LiveKit, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## QwenPaw

The skill scanner's rules in `packages/runtime/src/skill-scan.ts` port QwenPaw's skill_scanner signatures and default
policy (https://github.com/agentscope-ai/QwenPaw, `src/qwenpaw/security/skill_scanner/`) to TypeScript, with their
severities re-rated, Apache License 2.0:

```
Copyright 2025 The QwenPaw Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Cisco AI Defense skill-scanner

The skill scanner's hidden Unicode checks (Unicode Tag Block ASCII smuggling, zero-width characters), its markdown
image and link exfiltration rules and its credential harvesting phrases in `packages/runtime/src/skill-scan.ts` follow
Cisco AI Defense's skill-scanner (https://github.com/cisco-ai-defense/skill-scanner), Apache License 2.0:

```
Copyright 2026 Cisco Systems, Inc. and its affiliates

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## oh-my-pi (omp)

The rule-file discovery in `packages/runtime/src/rule-files.ts` (which files each tool keeps rules in, how their
frontmatter decides when a rule applies, and the check that skips a file already contained in another), the github
tool in `packages/runtime/src/github.ts` (the `gh` operations, their arguments and the Actions run report, after
omp's `tools/gh*.ts`), the find tool's search cascade in `packages/runtime/src/find.ts` (after omp's
`tools/jfind/cascade.ts`), and the stream rules (time-traveling stream rules) in `packages/runtime/src/stream-rules.ts`
and `packages/runtime/src/rule-draft.ts` (the rule-building step of `discovery/helpers.ts`, the stream check and retry
of `session/ttsr-coordinator.ts`, and the guidance and rule-drafting prompts of `prompts/system/ttsr-interrupt.md` and
`prompts/system/omfg-user.md`, adapted in `packages/runtime/src/prompts.ts`) are ported from oh-my-pi 18.8.7
(https://github.com/can1357/oh-my-pi), MIT License. So are, in `packages/runtime/src/`: the skills
registry client in `skill-registry.ts` (from `skillshare/client.ts`, `skillshare/installer.ts` and
`pi-wire/src/skillshare.ts`: package specs, routes, version resolution), the resolution of a marketplace plugin's
source in `marketplaces.ts` (from `extensibility/plugins/marketplace/source-resolver.ts` and `fetcher.ts`), and the npm
package-name check in `install-sources.ts` (from `extensibility/plugins/installer.ts`). So are the encrypted share
files in `apps/web/src/client/chat/share.ts` (the sealed layout, key and in-browser decryption of omp's
`export/share.ts` and `export/html/share-loader.js`) and the self-contained HTML export in
`packages/runtime/src/chat-export.ts` (after omp's `export/html` page). So is the memory engine in
`packages/runtime/src/memory.ts` and `memory-review.ts`: relevance ranking after pi-mnemopi's `core/mmr.ts` and
`core/weibull.ts`, the extraction and tidy-up prompts after `prompts/memories/sharpshooter-*.md` (with their evidence
rule), and the recall and remember tools after `tools/memory-recall.ts` and `tools/memory-retain.ts`; it also calls
omp's memory redaction (`memory-backend/redact.ts`) and recall content helpers (`hindsight/content.ts`) as a library.
`install-sources.ts` and `marketplaces.ts` also call omp's git URL parser, marketplace catalog parser and tar reader
as a library:

```
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
