# Personal skill template

The package ships a self-contained [mobile-device-lease skill](../examples/skills/mobile-device-lease/SKILL.md)
alongside the [standing rules](agent-instructions.md). It uses globally installed
commands and needs no application repository changes. It covers captured device
identity, launcher targeting, manual testing across replies, idle renewal and
release. Keep the standing rule too: installing a skill does not guarantee the
agent will select it for every device task.

After installing the CLI, copy the template to your client's personal skill
directory. For a new Codex personal skill:

```sh
mkdir -p "$HOME/.agents/skills/mobile-device-lease"
cp -n "$(npm root -g)/agent-mobile-device-lease/examples/skills/mobile-device-lease/SKILL.md" \
  "$HOME/.agents/skills/mobile-device-lease/SKILL.md"
```

These commands create only personal files. `cp -n` preserves an existing file;
review and merge updates into an existing skill rather than overwriting local
guidance. If multiple Node/global installations exist, compare `npm root -g`
with the installation reported by `device-lease adoption-check --scope personal`.

Codex's current [official skill documentation](https://learn.chatgpt.com/docs/build-skills)
lists `~/.agents/skills` for user skills and supports explicit invocation with
`$mobile-device-lease`. Confirm the skill appears in your client; restart it if
discovery has not refreshed. Other clients and older installations may use
different personal locations. Choose their documented location and declare it
in the [adoption check configuration](commands.md#inspect-adoption).

For an already-open chat, confirm the skill/rule is active before device work;
provide the rule directly or start a fresh session if it has not loaded.
Skill discovery and standing instruction loading are distinct. See
[personal instruction refresh](adoption.md#personal-your-agents-on-your-mac).

Run `device-lease adoption-check --scope personal` to inspect candidate locations,
then `device-lease doctor --platform android` (or `ios`) to check SDK prerequisites
and capacity. The adoption check does not load the skill, validate its contents or
prove an agent is participating. You still need the shared registry and a launcher
that honours the captured device. The Android and iOS [personal adapters](integration.md#personal-migration-of-a-first-device-installer)
provide examples for launchers that otherwise select the first device.

Upgrading the CLI does not update saved skills or rules. Compare both with the
new release. Project/team adoption continues to use a pinned dependency and
committed shared instructions; this personal template does not require adopting
that scope.
