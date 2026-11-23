import { useEffect, useId, useRef, useState } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Janela por cima da página. O fundo fica desfocado e bloqueado: clicar fora não fecha (perderia o
// que foi preenchido), só avisa balançando a janela. Sai-se pelo botão de concluir, cancelar ou ×.
// O Tab circula só dentro da janela.
//
// onBack is optional. When supplied, a back arrow renders in the header's
// top-left and the title shifts right to make room. Used by the SO modal's
// Related Records tab, where clicking a related record swaps the modal's
// contents in place and the operator needs a way back to where they
// started. Omitting it renders exactly what every other caller renders.
export default function Modal({ title, onClose, children, footer, size, onBack, backLabel }) {
  const className = size ? `modal modal-${size}` : 'modal';
  const titleId = useId();
  const box = useRef(null);
  const [nudge, setNudge] = useState(false);

  useEffect(() => {
    const previous = document.activeElement;
    const node = box.current;
    // O foco vai para a janela, não para um botão: um Enter sem querer não confirma nada.
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  function keepFocusInside(e) {
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll(FOCUSABLE)];
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function outsideClick(e) {
    if (e.target !== e.currentTarget) return;
    // Recomeça a animação mesmo com cliques seguidos, sem remontar o conteúdo.
    setNudge(false);
    requestAnimationFrame(() => setNudge(true));
  }

  return (
    <div className="modal-overlay" onMouseDown={outsideClick} data-testid="modal-overlay">
      <div
        ref={box}
        className={`${className}${nudge ? ' modal-nudge' : ''}`}
        onAnimationEnd={(e) => { if (e.target === e.currentTarget) setNudge(false); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
      >
        <div className="modal-header">
          {onBack && (
            <button
              type="button"
              className="modal-back"
              onClick={onBack}
              aria-label={backLabel ? `Voltar para ${backLabel}` : 'Voltar'}
              title={backLabel ? `Voltar para ${backLabel}` : 'Voltar'}
              data-testid="modal-back"
            >
              &#8592;
            </button>
          )}
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar" title="Fechar">&times;</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
