import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// Com a suíte rodando em paralelo, algumas esperas (findBy*/waitFor) passavam de 1 s em máquina
// carregada e falhavam sem defeito no código. Mais folga não muda o que cada teste confere.
configure({ asyncUtilTimeout: 5000 });
