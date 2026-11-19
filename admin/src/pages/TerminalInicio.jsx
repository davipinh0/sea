import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';

// SEA (mig 098): what the terminal account sees. It holds only the
// "Terminal de retirada" permission: its single option is to open the
// terminal, where each employee identifies (with the SEA login or, without
// access to the SEA, with the corporate e-mail).
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
