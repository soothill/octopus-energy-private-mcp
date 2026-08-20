import { CopyButton } from "./copy-button";

const repositoryUrl = "https://github.com/soothill/octopus-energy-private-mcp";
const downloadUrl = `${repositoryUrl}/archive/refs/heads/main.zip`;

function Command({ children, label = "Copy" }: { children: string; label?: string }) {
  return (
    <div className="command-box">
      <code>{children}</code>
      <CopyButton text={children} label={label} />
    </div>
  );
}

const howToData = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "How to install Octopus Energy Private MCP",
  description:
    "Install a private local MCP for Octopus Energy and connect it to ChatGPT desktop or Codex.",
  totalTime: "PT15M",
  supply: [
    { "@type": "HowToSupply", name: "Octopus Energy account" },
    { "@type": "HowToSupply", name: "Mac, Windows, or Linux computer" },
  ],
  tool: [
    { "@type": "HowToTool", name: "Node.js LTS" },
    { "@type": "HowToTool", name: "ChatGPT desktop app or Codex" },
  ],
  step: [
    { "@type": "HowToStep", name: "Install Node.js", text: "Install Node.js LTS version 22 or newer." },
    { "@type": "HowToStep", name: "Download the MCP", text: "Download and unpack the repository ZIP." },
    { "@type": "HowToStep", name: "Prepare the MCP", text: "Install its components and build the local server." },
    { "@type": "HowToStep", name: "Get Octopus details", text: "Copy your API key and account number from Developer settings." },
    { "@type": "HowToStep", name: "Save credentials locally", text: "Put the two values in the local .env file." },
    { "@type": "HowToStep", name: "Connect the MCP", text: "Add the local STDIO server in ChatGPT desktop or Codex." },
  ],
};

const faqData = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Do I need to know how to code?",
      acceptedAnswer: { "@type": "Answer", text: "No. The guide explains every click and every command." },
    },
    {
      "@type": "Question",
      name: "Does the website receive my Octopus Energy API key?",
      acceptedAnswer: { "@type": "Answer", text: "No. Credentials are saved only in a local file on your computer." },
    },
    {
      "@type": "Question",
      name: "Can I use this in ChatGPT on the web?",
      acceptedAnswer: { "@type": "Answer", text: "No. This local STDIO MCP must run in ChatGPT desktop or another local Codex client." },
    },
  ],
};

export default function Home() {
  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howToData).replace(/</g, "\\u003c") }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqData).replace(/</g, "\\u003c") }}
      />

      <header className="site-header">
        <a className="brand" href="#top" aria-label="Octopus Energy Private MCP home">
          <span className="brand-mark" aria-hidden="true">O/E</span>
          <span>Octopus Energy <strong>Private MCP</strong></span>
        </a>
        <nav className="desktop-nav" aria-label="Main navigation">
          <a href="#setup">Setup</a>
          <a href="#check">Check it</a>
          <a href="#help">Help</a>
        </nav>
        <a className="header-link" href={repositoryUrl} rel="noreferrer">
          View on GitHub <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span /> Private · local · read-only</p>
          <h1>Ask better questions about your energy use.</h1>
          <p className="hero-intro">
            Connect your Octopus Energy account to ChatGPT desktop or Codex in about
            15 minutes. Your credentials stay on your computer, and this guide walks
            through every click.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#setup">
              Start the setup <span aria-hidden="true">↓</span>
            </a>
            <a className="button button-secondary" href="#before-you-start">
              See what you need
            </a>
          </div>
          <p className="support-line">No coding experience needed. Free and open source.</p>
        </div>

        <aside className="preview-card" aria-label="Example energy question">
          <div className="preview-topline"><span className="status-dot" /> Ready to help</div>
          <p className="preview-question">“When was my electricity cheapest last week?”</p>
          <div className="answer-bars" aria-hidden="true">
            <span className="bar bar-one" />
            <span className="bar bar-two" />
            <span className="bar bar-three" />
          </div>
          <div className="preview-result">
            <span className="result-time">02:00—04:00</span>
            <span className="result-label">best two-hour window</span>
          </div>
          <div className="privacy-note">
            <span aria-hidden="true">✓</span>
            <p><strong>Runs on your computer</strong><br />No third-party analytics or telemetry</p>
          </div>
        </aside>
      </section>

      <section className="signal-strip" aria-label="Guide summary">
        <div>
          <span>Local MCP / 01</span>
          <p>Private energy data. Clear setup. No cloud middleman.</p>
          <p>Mac · Windows · Linux</p>
        </div>
      </section>

      <section className="needs" id="before-you-start">
        <div className="section-kicker">Before you start</div>
        <div className="needs-grid">
          <article>
            <span className="need-number">01</span>
            <h2>Your Octopus login</h2>
            <p>You will copy two details from your account. Your password is never needed.</p>
          </article>
          <article>
            <span className="need-number">02</span>
            <h2>A desktop computer</h2>
            <p>Mac, Windows, or Linux. Keep about 15 minutes free for the first setup.</p>
          </article>
          <article>
            <span className="need-number">03</span>
            <h2>ChatGPT desktop or Codex</h2>
            <p>The MCP runs locally and appears as a set of energy tools in your app.</p>
          </article>
        </div>
      </section>

      <section className="setup-section" id="setup">
        <div className="setup-heading">
          <p className="section-kicker">Your 15-minute setup</p>
          <h2>Follow each step in order.</h2>
          <p>Nothing here changes your Octopus account. If a step does not look right, stop and use the help section before moving on.</p>
        </div>

        <div className="guide-layout">
          <aside className="step-index" aria-label="Setup steps">
            <p>Setup progress</p>
            <ol>
              <li><a href="#step-1"><span>1</span> Install Node.js</a></li>
              <li><a href="#step-2"><span>2</span> Download the MCP</a></li>
              <li><a href="#step-3"><span>3</span> Prepare it</a></li>
              <li><a href="#step-4"><span>4</span> Get your details</a></li>
              <li><a href="#step-5"><span>5</span> Save them locally</a></li>
              <li><a href="#step-6"><span>6</span> Connect the app</a></li>
            </ol>
          </aside>

          <div className="steps">
            <article className="guide-step" id="step-1">
              <div className="step-heading">
                <span className="step-number">1</span>
                <div><p>About 3 minutes</p><h3>Install Node.js</h3></div>
              </div>
              <p className="step-lead">Node.js is the free software that runs the MCP on your computer.</p>
              <ol className="plain-steps">
                <li>Open the <a href="https://nodejs.org/en/download" rel="noreferrer">official Node.js download page ↗</a>.</li>
                <li>Choose the version marked <strong>LTS</strong>. Version 22 or newer is required.</li>
                <li>Download the normal installer for your computer, open it, and accept the standard options.</li>
                <li>Open Terminal on Mac or Linux, or PowerShell on Windows.</li>
              </ol>
              <div className="platform-grid compact">
                <div><span>Mac</span><p>Press Command + Space, type “Terminal”, then press Return.</p></div>
                <div><span>Windows</span><p>Open Start, type “PowerShell”, then open Windows PowerShell.</p></div>
                <div><span>Linux</span><p>Open the Terminal app supplied with your Linux desktop.</p></div>
              </div>
              <p>Paste this command and press Return or Enter:</p>
              <Command>node --version</Command>
              <div className="success-box"><span>✓</span><p><strong>You are ready when</strong> the answer begins with <code>v22</code>, <code>v24</code>, or a larger number.</p></div>
            </article>

            <article className="guide-step" id="step-2">
              <div className="step-heading">
                <span className="step-number">2</span>
                <div><p>About 2 minutes</p><h3>Download the MCP</h3></div>
              </div>
              <p className="step-lead">Download one ZIP file, unpack it, and put the folder somewhere permanent.</p>
              <a className="download-card" href={downloadUrl}>
                <span className="download-icon" aria-hidden="true">↓</span>
                <span><strong>Download the latest ZIP</strong><small>From the public GitHub repository</small></span>
                <span aria-hidden="true">↗</span>
              </a>
              <ol className="plain-steps">
                <li>Open the downloaded ZIP file to unpack it.</li>
                <li>Move <code>octopus-energy-private-mcp-main</code> into your Documents folder.</li>
                <li>Keep it there. Moving it later will break the saved connection until you update its path.</li>
              </ol>
              <p className="small-note">Prefer Git? You can instead run <code>git clone {repositoryUrl}.git</code>, but the ZIP route is simpler.</p>
            </article>

            <article className="guide-step" id="step-3">
              <div className="step-heading">
                <span className="step-number">3</span>
                <div><p>About 4 minutes</p><h3>Prepare the MCP</h3></div>
              </div>
              <p className="step-lead">Open a command window in the folder you just downloaded.</p>
              <div className="platform-stack">
                <details open>
                  <summary><span>Mac</span> The drag-and-drop way</summary>
                  <p>Open Terminal. Type <code>cd</code> followed by one space. Drag the MCP folder from Finder into Terminal, then press Return.</p>
                </details>
                <details>
                  <summary><span>Windows</span> Open PowerShell in the folder</summary>
                  <p>Open the MCP folder in File Explorer. Click the address bar, type <code>powershell</code>, and press Enter.</p>
                </details>
                <details>
                  <summary><span>Linux</span> Open a terminal here</summary>
                  <p>Open the MCP folder in your file manager, right-click an empty area, and choose “Open in Terminal”.</p>
                </details>
              </div>
              <p>Run these commands one at a time. Wait for each to finish:</p>
              <Command>npm ci</Command>
              <Command>npm run build</Command>
              <div className="tip-box"><strong>Yellow warnings are usually okay.</strong> Stop only if the final lines say <code>npm error</code> or that the build failed.</div>
            </article>

            <article className="guide-step" id="step-4">
              <div className="step-heading">
                <span className="step-number">4</span>
                <div><p>About 2 minutes</p><h3>Get your Octopus details</h3></div>
              </div>
              <p className="step-lead">You need an API key and account number—not your password or meter numbers.</p>
              <ol className="plain-steps">
                <li>Sign in to the <a href="https://octopus.energy/dashboard/developer/" rel="noreferrer">Octopus Developer settings page ↗</a>.</li>
                <li>Copy your <strong>API key</strong>. It normally begins with <code>sk_live_</code>.</li>
                <li>Copy your <strong>account number</strong>. It begins with <code>A-</code> and is also shown on your bill.</li>
              </ol>
              <div className="secret-box">
                <span aria-hidden="true">!</span>
                <p><strong>Your API key is like a password.</strong> Never paste it into this website, a chat, a GitHub issue, or a screenshot. You will put it only in a file on your own computer.</p>
              </div>
            </article>

            <article className="guide-step" id="step-5">
              <div className="step-heading">
                <span className="step-number">5</span>
                <div><p>About 2 minutes</p><h3>Save the details locally</h3></div>
              </div>
              <p className="step-lead">Return to the same Terminal or PowerShell window. Choose your computer below.</p>
              <div className="platform-stack commands">
                <details open>
                  <summary><span>Mac</span> Create and open the private settings file</summary>
                  <Command>cp .env.example .env</Command>
                  <Command>open -e .env</Command>
                </details>
                <details>
                  <summary><span>Windows</span> Create and open the private settings file</summary>
                  <Command>Copy-Item .env.example .env</Command>
                  <Command>notepad .env</Command>
                </details>
                <details>
                  <summary><span>Linux</span> Create and open the private settings file</summary>
                  <Command>cp .env.example .env</Command>
                  <Command>xdg-open .env</Command>
                </details>
              </div>
              <p>In the file, replace only the two example values at the top with your own:</p>
              <div className="file-example" aria-label="Example environment file">
                <div><span>OCTOPUS_API_KEY</span>=<mark>your API key</mark></div>
                <div><span>OCTOPUS_ACCOUNT_NUMBER</span>=<mark>your A- account number</mark></div>
                <div className="muted"><span>OCTOPUS_TIMEZONE</span>=Europe/London</div>
              </div>
              <p>Do not add quote marks or spaces around the values. Save the file and close the editor.</p>
              <p className="small-note">Windows users: make sure the file is named exactly <code>.env</code>, not <code>.env.txt</code>.</p>
            </article>

            <article className="guide-step final-step" id="step-6">
              <div className="step-heading">
                <span className="step-number">6</span>
                <div><p>About 2 minutes</p><h3>Connect ChatGPT desktop or Codex</h3></div>
              </div>
              <p className="step-lead">This helper prints the exact, secret-free connection details for your computer:</p>
              <Command>npm run setup:codex</Command>
              <ol className="app-steps">
                <li><span>1</span><p>Open the <strong>ChatGPT desktop app</strong>, then open <strong>Settings → MCP servers</strong>.</p></li>
                <li><span>2</span><p>Select <strong>Add server</strong>. Name it <code>Octopus Energy</code> and choose <strong>STDIO</strong>.</p></li>
                <li><span>3</span><p>Copy the printed <strong>Command</strong>, then add both printed <strong>Arguments</strong> in the same order.</p></li>
                <li><span>4</span><p>Save the server and select <strong>Restart</strong> when prompted.</p></li>
              </ol>
              <div className="official-note">
                These steps follow the <a href="https://learn.chatgpt.com/docs/extend/mcp?surface=cli" rel="noreferrer">official OpenAI MCP setup guide ↗</a>. The desktop app, Codex CLI, and IDE extension share this local configuration.
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="check-section" id="check">
        <div className="check-copy">
          <p className="section-kicker">The moment of truth</p>
          <h2>Check that it works.</h2>
          <p>After the app restarts, type <code>/mcp</code>. Make sure Octopus Energy is listed and enabled, then ask these two questions.</p>
        </div>
        <div className="check-questions">
          <div className="question-card">
            <span>First check</span>
            <p>“Check my Octopus Energy connection status and explain the result in plain English.”</p>
            <CopyButton text="Check my Octopus Energy connection status and explain the result in plain English." label="Copy question" />
          </div>
          <div className="question-card dark">
            <span>Then try</span>
            <p>“Discover my Octopus Energy meters and summarise what you find. Do not include my address.”</p>
            <CopyButton text="Discover my Octopus Energy meters and summarise what you find. Do not include my address." label="Copy question" />
          </div>
        </div>
      </section>

      <section className="ideas-section" id="ideas">
        <div className="ideas-heading">
          <p className="section-kicker">What to ask next</p>
          <h2>Your energy data becomes a conversation.</h2>
        </div>
        <div className="idea-grid">
          <blockquote>“Analyse my electricity usage over the last 30 days and point out the busiest times.”</blockquote>
          <blockquote className="accent">“Find the cheapest two-hour windows on my Agile tariff tomorrow.”</blockquote>
          <blockquote>“Compare this month with the previous equivalent period.”</blockquote>
          <blockquote>“How many Octoplus points do I have?”</blockquote>
        </div>
        <p className="cost-note">Cost results are estimates, not bills or quotes. They cannot reproduce every discount, credit, tax, or eligibility rule on an Octopus statement.</p>
      </section>

      <section className="help-section" id="help">
        <div className="help-heading">
          <p className="section-kicker">If something does not work</p>
          <h2>Start with the simple fixes.</h2>
          <p>The full written guide includes updating and removal instructions too.</p>
          <a className="text-link" href={`${repositoryUrl}/blob/main/docs/INSTALLATION.md`}>Open the complete installation guide ↗</a>
        </div>
        <div className="faq-list">
          <details>
            <summary>“node” or “npm” is not recognised <span>+</span></summary>
            <p>Close every Terminal or PowerShell window, restart the computer, and reinstall the LTS version from the official Node.js website.</p>
          </details>
          <details>
            <summary>The server says it failed to start <span>+</span></summary>
            <p>Open Terminal in the MCP folder, run <code>npm run build</code> and <code>npm run setup:codex</code>, then compare the newly printed paths with the saved MCP settings.</p>
          </details>
          <details>
            <summary>The API key or account is missing <span>+</span></summary>
            <p>Check that the local file is exactly <code>.env</code>, the two values have no quote marks or spaces, and the account number begins with <code>A-</code>. Save it and restart the app.</p>
          </details>
          <details>
            <summary>It works in Codex but not ChatGPT web <span>+</span></summary>
            <p>That is expected. This local MCP runs on your computer, so use the ChatGPT desktop app or another local Codex client rather than a normal browser tab.</p>
          </details>
          <details>
            <summary>I still need help <span>+</span></summary>
            <p>Open a GitHub issue with your operating system, the failed step, the error message, and <code>node --version</code>. Never include your API key, account number, address, or <code>.env</code> file.</p>
          </details>
        </div>
      </section>

      <section className="privacy-section">
        <div>
          <p className="section-kicker">Privacy by design</p>
          <h2>Your energy data stays between you and Octopus.</h2>
        </div>
        <ul>
          <li><span>✓</span> Runs as a local process—no public server</li>
          <li><span>✓</span> Sends credentials only to Octopus Energy</li>
          <li><span>✓</span> No third-party analytics or telemetry</li>
          <li><span>✓</span> Remote energy tools are read-only</li>
        </ul>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top">
          <span className="brand-mark" aria-hidden="true">O/E</span>
          <span>Octopus Energy <strong>Private MCP</strong></span>
        </a>
        <p>Independent community project. Not affiliated with or endorsed by Octopus Energy.</p>
        <div><a href={repositoryUrl}>GitHub</a><a href={`${repositoryUrl}/blob/main/SECURITY.md`}>Security</a><a href={`${repositoryUrl}/issues`}>Get help</a></div>
      </footer>
    </main>
  );
}
