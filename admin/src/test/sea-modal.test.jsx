/* Janela por cima da página: clicar fora não fecha nem perde o que foi preenchido. */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Modal from '../components/Modal.jsx';

function Form({ onClose }) {
  const [text, setText] = useState('');
  return (
    <Modal title="Novo usuário" onClose={onClose} footer={<button type="button" onClick={onClose}>Cancelar</button>}>
      <label htmlFor="nome">Nome</label>
      <input id="nome" value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}

describe('Modal', () => {
  it('is a blocking dialog named by its title', () => {
    render(<Form onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Novo usuário' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // O foco vai para a janela, não para um botão que confirmaria algo com Enter.
    expect(document.activeElement).toBe(dialog);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('a click outside does not close it nor lose what was typed', () => {
    const onClose = vi.fn();
    render(<Form onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana (fictícia)' } });
    fireEvent.mouseDown(screen.getByTestId('modal-overlay'));
    fireEvent.click(screen.getByTestId('modal-overlay'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Nome')).toHaveValue('Ana (fictícia)');
    // Clique dentro da janela também não fecha.
    fireEvent.mouseDown(screen.getByLabelText('Nome'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves only through cancel or ×', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Form onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps Tab inside the dialog', () => {
    render(<Form onClose={() => {}} />);
    const close = screen.getByRole('button', { name: 'Fechar' });
    const cancel = screen.getByRole('button', { name: 'Cancelar' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });
});
