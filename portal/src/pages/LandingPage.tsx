import { Link } from 'react-router-dom';
import { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export default function LandingPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [signupState, setSignupState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setSignupState('loading');
    setErrorMessage('');
    try {
      const res = await fetch(`${API_BASE}/v1/beta/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setSignupState('success');
    } catch (err) {
      setErrorMessage((err as Error).message);
      setSignupState('error');
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Nav */}
      <header className="flex items-center justify-between px-8 py-5 border-b border-gray-800">
        <span className="text-xl font-bold tracking-tight">⧖ Arachne</span>
        <div className="flex items-center gap-4">
          <Link to="/login" className="text-sm text-gray-400 hover:text-gray-100 transition-colors">
            Sign in
          </Link>
          <a
            href="#beta-signup"
            className="text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
          >
            Get started free
          </a>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center">
        {/* Hero */}
        <section className="flex flex-col items-center px-8 py-24 text-center max-w-3xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 text-xs font-medium bg-indigo-950 border border-indigo-800 text-indigo-300 px-3 py-1 rounded-full">
            Now in Beta · OpenAI-Compatible · Multi-Tenant
          </div>

          <h1 className="text-6xl font-bold tracking-tight bg-gradient-to-br from-white to-gray-400 bg-clip-text text-transparent">
            Docker for AI Agents
          </h1>

          <p className="text-2xl font-medium text-gray-300">
            Define it. Package it. Ship it. Run it anywhere.
          </p>

          <p className="text-lg text-gray-400">
            Arachne is the portable runtime for AI agents.
          </p>

          <div className="flex items-center justify-center gap-4 pt-2">
            <a
              href="#beta-signup"
              className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-colors"
            >
              Join the Beta
            </a>
            <Link
              to="/login"
              className="px-6 py-3 border border-gray-700 hover:border-gray-500 text-gray-300 font-medium rounded-lg transition-colors"
            >
              Sign in
            </Link>
          </div>
        </section>

        {/* 3 Steps */}
        <div className="w-full border-t border-gray-800">
          {/* Step 1 */}
          <section className="px-8 py-20 max-w-4xl mx-auto">
            <div className="space-y-6">
              <div className="text-indigo-400 text-sm font-semibold uppercase tracking-widest">Step 1</div>
              <h2 className="text-3xl font-bold text-gray-100">A Spec for Agents + Knowledge</h2>
              <p className="text-gray-400 text-lg">Define your agent in one declarative file:</p>
              <ul className="space-y-2 text-gray-300">
                {['Model + provider', 'Tools + skills', 'Memory', 'Knowledge bases', 'Guardrails'].map(item => (
                  <li key={item} className="flex items-center gap-3">
                    <span className="text-indigo-500">—</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <p className="text-gray-500 italic">Agents and knowledge are first-class artifacts — not scattered across code.</p>
            </div>
          </section>

          {/* Step 2 */}
          <section className="px-8 py-20 bg-gray-900/40 border-t border-b border-gray-800">
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="text-indigo-400 text-sm font-semibold uppercase tracking-widest">Step 2</div>
              <h2 className="text-3xl font-bold text-gray-100">Build AI Agents Like Containers</h2>
              <pre className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4 font-mono text-green-400 text-sm w-fit">
                arachne weave
              </pre>
              <p className="text-gray-400 text-lg">Package your agent into a portable bundle.</p>
              <ul className="space-y-2 text-gray-300">
                {['Agent definition', 'Model configuration', 'Deterministic RAG artifacts', 'Embedded knowledge references'].map(item => (
                  <li key={item} className="flex items-center gap-3">
                    <span className="text-indigo-500">—</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <p className="text-gray-500 italic">Reproducible. Versionable. Portable.</p>
            </div>
          </section>

          {/* Step 3 */}
          <section className="px-8 py-20 max-w-4xl mx-auto space-y-6">
            <div className="text-indigo-400 text-sm font-semibold uppercase tracking-widest">Step 3</div>
            <h2 className="text-3xl font-bold text-gray-100">Publish. Run. Deploy.</h2>
            <pre className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-4 font-mono text-green-400 text-sm">
              {`arachne push      # Publish to registry\narachne run       # Run locally\narachne deploy    # Deploy anywhere`}
            </pre>
            <ul className="space-y-2 text-gray-300">
              {[
                'Push to a registry',
                'Run locally for your dev cycle',
                'Deploy to your enterprise',
                'Or deploy to the hosted Arachne server',
              ].map(item => (
                <li key={item} className="flex items-center gap-3">
                  <span className="text-indigo-500">—</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <p className="text-gray-500 italic">Same artifact. Every environment.</p>
          </section>
        </div>

        {/* What the Runtime Gives You */}
        <section className="w-full border-t border-gray-800 px-8 py-20">
          <div className="max-w-5xl mx-auto space-y-12">
            <div className="text-center space-y-3">
              <h2 className="text-3xl font-bold text-gray-100">What the Runtime Gives You</h2>
              <p className="text-gray-400">This isn't just packaging. It's an AI execution layer.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              {[
                {
                  icon: '🧠',
                  title: 'Automatic Agentic Memory',
                  desc: 'Built-in memory with sensible defaults. Conversation memory, tool state tracking, configurable persistence, swappable backends. No wiring required.',
                },
                {
                  icon: '📦',
                  title: 'Deterministic RAG Bundles',
                  desc: 'Build knowledge bases at build time. Vectorized during arachne weave. Versioned artifacts. Immutable knowledge snapshots. No re-embedding surprises in production.',
                },
                {
                  icon: '📊',
                  title: 'Observability Built In',
                  desc: 'Tracing, cost, latency, execution paths — part of the runtime. No SDK patching. No proxy layers. No glue code. Just visibility.',
                },
              ].map(f => (
                <div
                  key={f.title}
                  className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3"
                >
                  <div className="text-3xl">{f.icon}</div>
                  <h3 className="font-semibold text-gray-100">{f.title}</h3>
                  <p className="text-sm text-gray-400 leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Why Arachne */}
        <section className="w-full border-t border-gray-800 px-8 py-20 bg-gray-900/40">
          <div className="max-w-3xl mx-auto space-y-10 text-center">
            <h2 className="text-3xl font-bold text-gray-100">Why Arachne</h2>
            <div className="text-left space-y-4">
              <p className="text-gray-400">Today you stitch together:</p>
              <ul className="space-y-2 text-gray-300">
                {['Framework', 'Vector DB', 'Gateway', 'Observability', 'Eval layer', 'Custom deployment glue'].map(item => (
                  <li key={item} className="flex items-center gap-3">
                    <span className="text-red-500">✗</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <p className="text-xl font-semibold text-gray-100">Arachne replaces the glue.</p>
              <p className="text-gray-400">It standardizes the runtime.</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-8 py-6 space-y-3">
              <p className="text-lg font-bold text-gray-100">Build AI Like Software.</p>
              <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-indigo-400 font-mono text-sm">
                <span>Spec it</span>
                <span className="text-gray-600">→</span>
                <span>Weave it</span>
                <span className="text-gray-600">→</span>
                <span>Push it</span>
                <span className="text-gray-600">→</span>
                <span>Deploy it</span>
              </div>
            </div>
          </div>
        </section>

        {/* Beta signup */}
        <section id="beta-signup" className="mt-0 w-full max-w-md mx-auto text-center space-y-6 px-8 py-20">
          <h2 className="text-2xl font-bold text-gray-100">Get early access</h2>
          <p className="text-gray-400 text-sm">Join the waitlist and we'll reach out when your spot is ready.</p>

          {signupState === 'success' ? (
            <div className="bg-green-900/40 border border-green-700 text-green-300 rounded-xl px-6 py-5 text-sm font-medium">
              🎉 You're on the list! We'll be in touch soon.
            </div>
          ) : (
            <form onSubmit={handleSignup} className="space-y-3">
              <input
                type="text"
                placeholder="Name (optional)"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm"
              />
              <input
                type="email"
                placeholder="Email address"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm"
              />
              {signupState === 'error' && (
                <p className="text-red-400 text-xs text-left">{errorMessage}</p>
              )}
              <button
                type="submit"
                disabled={signupState === 'loading'}
                className="w-full px-6 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
              >
                {signupState === 'loading' ? 'Joining…' : 'Join the Beta Waitlist'}
              </button>
            </form>
          )}
        </section>
      </main>

      <footer className="text-center text-xs text-gray-600 py-6 border-t border-gray-800 space-y-1">
        <div>© 2026 Synaptic Weave, Inc. All rights reserved.</div>
        <div className="flex items-center justify-center gap-4">
          <Link to="/about" className="hover:text-gray-400 transition-colors">About</Link>
          <Link to="/privacy" className="hover:text-gray-400 transition-colors">Privacy Policy</Link>
        </div>
      </footer>
    </div>
  );
}
