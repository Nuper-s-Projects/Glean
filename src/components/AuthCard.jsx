import Brand from './Brand';

export default function AuthCard({ children, variant = '' }) {
  return (
    <main className={`auth-card ${variant}`}>
      <Brand />
      {children}
    </main>
  );
}
