import { Component } from 'react';

const box = { padding: 16, margin: 16, background: '#2a1114', color: '#ffb4b4', font: '13px/1.4 monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderRadius: 8 };

// Mostra o erro na tela (útil no celular, onde não há console).
export default class ErrorBoundary extends Component {
  state = { error: null, late: null, info: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(error, info?.componentStack);
    this.setState({ info: info?.componentStack || null });
  }

  componentDidMount() {
    if (this.props.global === false) return;
    this.onLate = (e) => this.setState({ late: e.error || e.reason || e.message });
    window.addEventListener('error', this.onLate);
    window.addEventListener('unhandledrejection', this.onLate);
  }

  componentWillUnmount() {
    if (this.props.global === false) return;
    window.removeEventListener('error', this.onLate);
    window.removeEventListener('unhandledrejection', this.onLate);
  }

  render() {
    const { error, late } = this.state;
    const shown = error || late;
    if (!shown) return this.props.children;
    const text = `${shown?.stack || shown?.message || String(shown)}${error && this.state.info ? `\n\n${this.state.info}` : ''}`;
    return (
      <div style={box}>
        <b>{error ? 'O app quebrou' : 'Erro não tratado'}</b>
        {'\n\n'}
        {text}
        {'\n\n'}
        {this.props.global === false
          ? <button onClick={() => this.setState({ error: null, info: null })}>Tentar de novo</button>
          : <button onClick={() => location.reload()}>Recarregar</button>}
        {!error && <button onClick={() => this.setState({ late: null })}>Ignorar</button>}
      </div>
    );
  }
}
