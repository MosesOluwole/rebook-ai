import Link from 'next/link';

export default function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p>There is nothing at this address for you.</p>
      <p>
        <Link href="/app">Go to your workspace</Link>
      </p>
    </main>
  );
}
