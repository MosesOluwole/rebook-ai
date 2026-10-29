import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>Rebook AI</h1>
      <p>Phase 0 skeleton. The application arrives in later phases.</p>
      <p>
        <Link href="/health">Health check</Link>
      </p>
    </main>
  );
}
