export function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-4xl font-bold">Privacy Policy</h1>

      <p className="mt-2 text-sm text-gray-500">
        Last updated: July 2026
      </p>

      <div className="mt-10 space-y-8">

        <section>
          <h2 className="text-2xl font-semibold">
            Introduction
          </h2>

          <p className="mt-3">
            Aqua AI ("we", "our", or "us") is committed to protecting your
            privacy. This Privacy Policy explains what information we collect,
            how we use it, and the choices you have regarding your data when
            using Aqua AI.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">
            Information We Collect
          </h2>

          <ul className="mt-3 list-disc pl-6 space-y-2">
            <li>Account information</li>
            <li>Chat conversations</li>
            <li>Uploaded files</li>
            <li>Device information</li>
            <li>Usage analytics</li>
          </ul>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">
            How We Use Your Information
          </h2>

          <ul className="mt-3 list-disc pl-6 space-y-2">
            <li>Provide AI responses</li>
            <li>Improve the service</li>
            <li>Maintain conversation history</li>
            <li>Protect against abuse and fraud</li>
            <li>Improve performance and reliability</li>
          </ul>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">
            AI Processing
          </h2>

          <p className="mt-3">
            Messages and uploaded content may be processed by AI models to
            generate responses and improve your experience.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">
            Contact Us
          </h2>

          <p className="mt-3">
            Questions about this Privacy Policy can be sent to:
          </p>

          <p className="mt-2 font-medium">
            support@aquiplex.ai
          </p>
        </section>

      </div>
    </main>
  );
}