---
prompts:
  - prompt: Our climbing gym's front desk must keep taking bookings when the internet drops. Build a local server that replicates our Firestore data, takes over the LAN, and syncs back when the connection returns.
    stack: Firestore + RxDB
  - prompt: Our kiosks run in the browser. Make them switch to the local box on their own when the cloud is unreachable, without staff doing anything.
    stack: Firestore + RxDB
---

# Prompts

What an operator types after installing this skill, in their own words. An agent eval installs the skill
into an empty Next.js app, gives the agent one of these prompts and no further help, then type-checks, builds
and tests the result; the first prompt runs before every release. The results are the other files in this
folder. Section 10 of [STANDARD.md](https://github.com/timerise-ai/skills/blob/main/STANDARD.md) says how a
run is made. The prompts and the newest runs are on
[the skill's page](https://timerise.ai/skills/island-mode-server) on timerise.ai.
