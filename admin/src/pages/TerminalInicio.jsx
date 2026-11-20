import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';

// Tela do usuário do terminal: a única opção é abrir o terminal.
export default function TerminalInicio() {
  return (
    <div>
      <PageHeader title="Retirada" />
      <div className="card" style={{ maxWidth: 560 }}>
        <p>Este usuário é do terminal de retirada. Abra o terminal e deixe-o na tela para os funcionários pedirem material.</p>
        <Link to="/retirada/terminal" className="btn btn-primary">Abrir terminal de retirada</Link>
      </div>
    </div>
  );
}
