import { describe, it, expect } from 'vitest';
import { pickNew } from '../notificationPolling';

const n = (id) => ({ notification_id: id, title: `Aviso ${id}` });

describe('pickNew', () => {
  it('announces nothing on the first poll after opening the app', () => {
    // Regressão: ao entrar no app, os avisos já vistos (push ou painel) eram anunciados de novo.
    expect(pickNew([n(12), n(11), n(10)], null)).toEqual({ last: 12, fresh: [] });
  });

  it('starts from zero when there is nothing yet', () => {
    expect(pickNew([], null)).toEqual({ last: 0, fresh: [] });
    expect(pickNew(undefined, null)).toEqual({ last: 0, fresh: [] });
  });

  it('announces only what is newer than the last known id', () => {
    expect(pickNew([n(14), n(13), n(12)], 12)).toEqual({ last: 14, fresh: [n(14), n(13)] });
  });

  it('keeps the last known id when the poll brings nothing new', () => {
    expect(pickNew([], 12)).toEqual({ last: 12, fresh: [] });
    expect(pickNew([n(12), n(9)], 12)).toEqual({ last: 12, fresh: [] });
  });

  it('never announces the same notification twice across polls', () => {
    let state = pickNew([n(5)], null);
    state = pickNew([n(6), n(5)], state.last);
    expect(state.fresh).toEqual([n(6)]);
    state = pickNew([n(6)], state.last);
    expect(state.fresh).toEqual([]);
  });
});
