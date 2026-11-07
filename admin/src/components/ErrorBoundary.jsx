import React from 'react';
import { logBoundaryError } from '../utils/safeLogging';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // V-020: scrub Bearer tokens, JWTs, and URL userinfo before logging.
    // In production only a minimal error name + message is written.
    logBoundaryError(error, errorInfo);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          background: '#f7f3ec',
          border: '1px solid #e0d9cc',
          borderRadius: '8px',
          margin: '1rem'
        }}>
          <h2 style={{ color: '#8e2716' }}>Algo deu errado</h2>
          <p style={{ color: '#666' }}>
            {this.props.fallbackMessage || 'Esta seção encontrou um erro. Tente atualizar a página.'}
          </p>
          <button
            onClick={this.reset}
            style={{
              background: '#8e2716',
              color: 'white',
              border: 'none',
              padding: '0.5rem 1rem',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Tentar novamente
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
