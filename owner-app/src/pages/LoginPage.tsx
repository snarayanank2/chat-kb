import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../state/AuthContext";

export function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  if (loading) {
    return <p className="state-text">Loading session...</p>;
  }
  if (session) {
    return <Navigate to="/projects" replace />;
  }

  const handleGoogleSignIn = async () => {
    setError(null);
    setSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Google sign-in.");
      setSigningIn(false);
    }
  };

  return (
    <div className="login-wrap">
      <section className="panel login-panel">
        <h1>Owner dashboard</h1>
        <p className="muted">
          Sign in with Google to manage projects, origin allowlists, limits, and
          ingestion visibility.
        </p>
        <button type="button" onClick={handleGoogleSignIn} disabled={signingIn}>
          {signingIn ? "Redirecting..." : "Sign in with Google"}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </section>
    </div>
  );
}
