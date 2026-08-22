# Beginner installation guide

This guide is written for people who do not normally use developer tools. You do not need to know how to code. Allow about 15 minutes and follow the steps in order.

Prefer to follow this in a browser? Open the [interactive setup website](https://octopus-energy-private-mcp-guide.darren138956.chatgpt.site).

The MCP runs on your own computer. It connects your Octopus Energy account to the ChatGPT desktop app, Codex CLI, or the Codex IDE extension. It does **not** work in an ordinary ChatGPT web-browser tab because local MCP servers run on your computer.

Your API key is read locally and sent only to Octopus Energy. Account, tariff, consumption, cost and smart-device results are returned to your selected AI client and model, where your AI provider’s privacy and data controls apply. Do not request or share data you would not want that provider to process.

## Before you begin

You will need:

- a Mac, Windows, or Linux computer;
- an Octopus Energy account;
- the ChatGPT desktop app, Codex CLI, or Codex IDE extension;
- permission to install an application on your computer; and
- about 250 MB of free disk space.

Two names used in this guide:

- **Terminal** is the text-based app where you paste the short commands shown below. On Windows it is called **PowerShell**.
- **MCP** is the small local connector that gives ChatGPT or Codex the Octopus Energy tools.

> **Keep your API key private.** Treat it like a password. Never paste it into this guide website, a chat, an issue, or a screenshot. The only place you will enter it is the local `.env` file on your own computer.

## Step 1 — Install Node.js

Node.js is the free software that runs the MCP.

1. Open the [official Node.js download page](https://nodejs.org/en/download).
2. Choose the version labelled **LTS**. Version 22 or newer is required.
3. Download the normal installer for your computer and open it.
4. Accept the standard options and complete the installation.
5. Close and reopen Terminal or PowerShell if it was already open.

Check that it worked:

### Mac

1. Press **Command + Space**.
2. Type `Terminal` and press **Return**.
3. Paste this and press **Return**:

```bash
node --version
```

### Windows

1. Open the **Start** menu.
2. Type `PowerShell` and open **Windows PowerShell**.
3. Paste this and press **Enter**:

```powershell
node --version
```

### Linux

Open your usual Terminal app and run:

```bash
node --version
```

You should see a version beginning with `v22`, `v24`, or a larger number. If you see “command not found” or “not recognised”, restart your computer and try again. If it still fails, reinstall the LTS version from the Node.js website.

## Step 2 — Download the MCP

1. Open the [Octopus Energy Private MCP repository](https://github.com/soothill/octopus-energy-private-mcp).
2. Select the green **Code** button.
3. Select **Download ZIP**.
4. Open your Downloads folder and double-click the downloaded ZIP file to unpack it.
5. Move the unpacked `octopus-energy-private-mcp-main` folder somewhere you will keep it. Your Documents folder is a good choice. Do not leave it in a temporary folder and do not rename or move it after connecting it to ChatGPT.

## Step 3 — Prepare the MCP

First, open Terminal or PowerShell inside the downloaded folder.

### Mac — easiest method

1. Open Terminal.
2. Type `cd` followed by one space, but do not press Return yet.
3. Drag the `octopus-energy-private-mcp-main` folder from Finder into the Terminal window. Its full location will appear automatically.
4. Press **Return**.

### Windows — easiest method

1. Open the `octopus-energy-private-mcp-main` folder in File Explorer.
2. Click the address bar at the top, type `powershell`, and press **Enter**.
3. A PowerShell window will open in the correct folder.

### Linux — easiest method

Open the folder in your file manager, right-click an empty area, and choose **Open in Terminal**. The wording varies slightly by Linux distribution.

Now paste these two commands one at a time. Wait for each one to finish before continuing:

```bash
npm ci
npm run build
```

The first command downloads the MCP’s required components. The second prepares the MCP to run. Warnings in yellow are usually informational. Stop only if you see a final line beginning with `npm error` or the build says it failed.

## Step 4 — Get your Octopus details

1. Sign in to the [Octopus Energy account dashboard](https://octopus.energy/dashboard/developer/).
2. Open **Personal details**, then **Developer settings** if the developer page is not already visible.
3. Copy your **API key**. It normally starts with `sk_live_`.
4. Copy your **account number**. It starts with `A-` and is also shown on an Octopus bill.

You do not need to copy your MPAN, MPRN, or meter serial number. The MCP discovers those for you after connecting.

## Step 5 — Save the details locally

Return to the same Terminal or PowerShell window you used in Step 3.

### Mac

Paste these commands one at a time:

```bash
cp .env.example .env
open -e .env
```

### Windows

Paste these commands one at a time:

```powershell
Copy-Item .env.example .env
notepad .env
```

If Notepad asks whether to create the file, choose **Yes**. Make sure it remains named `.env`, not `.env.txt`.

### Linux

Paste these commands one at a time:

```bash
cp .env.example .env
xdg-open .env
```

When the file opens, replace only the two example values at the top:

```text
OCTOPUS_API_KEY=sk_live_replace_me
OCTOPUS_ACCOUNT_NUMBER=A-REPLACE_ME
```

For example, if your real details were `sk_live_example123` and `A-1234ABCD`, those lines would become:

```text
OCTOPUS_API_KEY=sk_live_example123
OCTOPUS_ACCOUNT_NUMBER=A-1234ABCD
```

Do not add quote marks or spaces around the values. Leave `OCTOPUS_TIMEZONE=Europe/London` and the other settings unchanged. Save the file and close the editor.

## Step 6 — Connect it to ChatGPT desktop or Codex

In Terminal or PowerShell, run:

```bash
npm run setup:codex
```

This prints the exact command and two arguments for your computer. It does not print or copy your API key.

Then:

1. Open the **ChatGPT desktop app**.
2. Open **Settings**.
3. Select **MCP servers**.
4. Select **Add server**.
5. Enter `Octopus Energy` as the name.
6. Choose **STDIO** as the type.
7. Copy the **Command** shown by `npm run setup:codex` into the Command field.
8. Add each of the two **Arguments** shown by the helper, in the same order.
9. Save the server.
10. Select **Restart** when prompted.

The ChatGPT desktop app, Codex CLI, and Codex IDE extension share the same local MCP configuration. If you use the Codex config file instead of the settings screen, append the printed `[mcp_servers.octopus_energy]` block to `~/.codex/config.toml`. On Windows the same file is inside `%USERPROFILE%\.codex\config.toml`. Do not replace other settings already in that file.

## Check that everything works

After the app restarts:

1. Type `/mcp` in a new ChatGPT or Codex conversation.
2. Confirm that **Octopus Energy** is listed and enabled.
3. Ask:

> Check my Octopus Energy connection status and explain the result in plain English.

The response should say that the API key and account are configured and that account queries are ready.

Then ask:

> Discover my Octopus Energy meters and summarise what you find. Do not include my address.

If both questions work, installation is complete.

## Useful first questions

- “Analyse my electricity usage over the last 30 days and point out the busiest times.”
- “Compare this month with the previous equivalent period.”
- “Find the cheapest two-hour windows on my Agile tariff tomorrow.”
- “Show the separate home and EV rates on my Intelligent Octopus Go tariff.”
- “Show Octopus’s EV charging consumption and costs for last month, separating smart charging from boost or other non-smart charging.”
- “Show my current import and export meters and their active agreements.”
- “How many Octoplus points do I have?”

The MCP supplies data and estimates, not billing advice. Conventional cost calculations do not reproduce every discount, credit, tax, eligibility rule, or billing adjustment on an Octopus statement.

For the newer Intelligent Octopus Go four-rate model, ask for your **EV tariff pricing** to see separate home peak, home off-peak, EV peak and EV off-peak account rates. Ask for **EV charge costs** to see the consumption and cost that Octopus calculated for smart and non-smart charging over a period. The MCP uses these account-priced Octopus records because ordinary whole-home meter data cannot tell which energy went to the car, whether it was inside the six-hour smart-charge allowance, or whether Boost was used.

Octopus returns this charge history by whole date. If you ask for a rolling period or use times as well as dates, the answer clearly shows the original period and the effective whole-day period sent to Octopus. If a returned record is missing a cost or consumption value, its total is shown as unavailable rather than adding up only the other records and making that partial amount look complete. A confirmed empty list shows zero totals; if Octopus returns no dataset at all, the MCP reports an error instead of guessing zero.

If a very long daily request exceeds the safety limit, ask for a shorter period or ask for weekly or monthly EV charge costs. The MCP rejects an oversized result instead of silently omitting records or calculating a partial total.

Drive Pack and Power Pack are type-of-use arrangements. Their subscription fees, credits and other account-level adjustments may be recorded separately from individual EV charge costs, so always use the Octopus app and statement as the final total.

## Troubleshooting

### “node” or “npm” is not recognised

Node.js is not installed correctly or the Terminal window was opened before installation. Close all Terminal or PowerShell windows, restart the computer, and repeat Step 1 using the LTS installer.

### `npm ci` ends with an error

Check that you are inside the folder containing `package.json`. If you are unsure, close the window and repeat the “open inside the downloaded folder” instructions in Step 3. Also check that your internet connection is working, then run `npm ci` again.

### The server appears but says it failed to start

Return to the MCP folder and run:

```bash
npm run build
npm run setup:codex
```

Compare the newly printed Command and Arguments with the MCP settings. A moved or renamed folder is the most common cause. Update the settings or move the folder back, then restart the app.

### The connection status says the API key or account is missing

Open `.env` again and check:

- the filename is exactly `.env` rather than `.env.txt`;
- the API key is on the `OCTOPUS_API_KEY=` line;
- the account number is on the `OCTOPUS_ACCOUNT_NUMBER=` line;
- there are no spaces or quote marks around either value; and
- the account number begins with `A-`.

Save the file and restart the ChatGPT desktop app.

### The API rejects the credentials

Copy the API key again from Octopus Developer settings. Do not copy surrounding spaces. Confirm that the account number belongs to the same Octopus login. If you regenerated an API key, update `.env` and restart the app.

### No consumption data appears

Smart-meter readings can arrive late, and new accounts may not have historical data yet. First ask the MCP to discover meters. If more than one meter is listed, include the meter or property you want in the next question.

### The MCP cannot replay my Intelligent Octopus Go or EV add-on tariff

This is a safety check, not a fault. The new Intelligent Octopus Go model can give the home and car different prices during the same half-hour, while Drive Pack and Power Pack can add separate subscriptions or credits. Whole-home meter readings are not enough to rebuild those rules reliably.

Ask:

> Show my active four-rate EV tariff pricing, then show Octopus’s EV charge costs for last month.

If no four-rate tariff appears, Octopus may not have enabled the new model on your account yet, or your account may use another tariff model. Check the Devices area in the Octopus app. EV charge records can also appear a day or so after charging rather than immediately.

Older `INTELLI-VAR` Intelligent Octopus Go tariffs continue to use the conventional published REST rates. They are not forced into the new four-rate tools unless Octopus has actually moved the account to a newer tariff model.

### The tools work in Codex but not in ChatGPT web

This is expected. A local STDIO MCP runs on your computer and is available to local Codex clients, including the ChatGPT desktop app’s Codex environment. An ordinary browser tab cannot start a process on your computer.

### You still need help

Open a [GitHub issue](https://github.com/soothill/octopus-energy-private-mcp/issues) and include:

- whether you use Mac, Windows, or Linux;
- which step failed;
- the exact error message; and
- the output of `node --version`.

Never include your API key, account number, address, meter identifiers, `.env` file, or screenshots containing those details.

## Updating later

Each time the MCP starts, it anonymously checks the version declared in this project’s public GitHub `main` branch. If that version is newer, ChatGPT or Codex receives a notice containing the installed and latest versions plus the relevant update steps below. The same secret-free notice is written to the MCP’s local error/log channel, and `octopus_connection_status` reports the result.

The check sends no Octopus API key, account number, energy data or cache content. It makes one request to `api.github.com`, rejects redirects, gives up after two seconds, and never prevents the MCP from starting. To disable the check, add this line to `.env` and restart the app:

```dotenv
OCTOPUS_UPDATE_CHECK_ENABLED=false
```

If you downloaded a ZIP:

1. Keep a safe copy of your `.env` file.
2. Download and unpack the latest ZIP from GitHub.
3. Copy your saved `.env` into the new folder.
4. Open Terminal or PowerShell in the new folder.
5. Run `npm ci`, `npm run build`, and `npm run setup:codex`.
6. Update the MCP Command and Arguments with the newly printed values.
7. Restart the app and repeat the connection check.

If you originally used Git, open Terminal in the project and run:

```bash
git pull
npm ci
npm run build
```

Then restart the app.

## Removing the MCP

1. While the MCP is still enabled, ask ChatGPT or Codex: “Clear all locally cached Octopus Energy responses. I confirm the deletion.” The `octopus_clear_cache` tool reports how many entries it removed.
2. Open **Settings → MCP servers** in the ChatGPT desktop app.
3. Remove or disable **Octopus Energy**.
4. Restart the app.
5. Delete the MCP folder from your computer if you no longer need it. This removes the local `.env` credentials file.

The default cache directory is separate from the MCP folder. After clearing it, you can also delete the empty `octopus-energy-mcp` cache directory at:

- **Mac or Linux:** `~/.cache/octopus-energy-mcp`
- **Windows:** `%USERPROFILE%\.cache\octopus-energy-mcp`

If you changed `OCTOPUS_CACHE_DIR` in `.env`, remove that configured directory instead. These steps do not change or delete anything in your Octopus Energy account.

## Privacy summary

- The MCP runs as a local process and does not open a network port.
- It sends credentials only to `api.octopus.energy` and refuses automatic redirects.
- It has no third-party analytics or telemetry.
- By default, startup anonymously reads the public project version from `api.github.com`; it sends no Octopus credentials or energy data and can be disabled with `OCTOPUS_UPDATE_CHECK_ENABLED=false`.
- It supplies returned account and energy data to the selected AI client and model; that provider’s privacy and data controls apply.
- It exposes named Octopus operations rather than arbitrary web or GraphQL access.
- Remote tools are read-only. The only destructive tool clears local cache files and requires confirmation.
- The public setup website never asks for or receives an API key.

For the complete technical threat model, see [SECURITY.md](../SECURITY.md).
