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
            Deleting Your Account and Data
          </h2>

          <p className="mt-3">
            You can permanently delete your account, and everything stored with it, at any
            time from <strong>Settings → Account → Delete account</strong> in the app. We
            ask you to confirm your password (or to confirm through Google, if you signed
            up with Google) before deletion runs.
          </p>

          <p className="mt-3">
            Deletion is immediate and irreversible. It removes your account and profile,
            every conversation and message, everything Aqua remembers about you, uploaded
            files and projects together with anything extracted from them, artifacts
            generated for you, your purchase and credit history, and every active session
            on every device.
          </p>

          <p className="mt-3">
            We retain a small, deliberate set of records that no longer identify you:
            anonymized billing event logs (which prevent a payment notification being
            processed twice), transaction records held by our payment provider under their
            own financial-regulation obligations, and anonymous aggregated reliability
            statistics that contain no messages, files, or identifiers.
          </p>

          <p className="mt-3">
            If you cannot sign in, email <strong>support@aquiplex.ai</strong> from your
            registered address with the subject “Delete my account”. We verify ownership and
            complete deletion within 30 days.{' '}
            <a href="/delete-account" className="underline">
              Full details are here
            </a>
            .
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