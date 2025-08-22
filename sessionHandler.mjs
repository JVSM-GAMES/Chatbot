import { Menu } from "./menu.mjs";

// Menu de atendimento
export const atendimentoMenu = new Menu("Bem-vindo! Escolha uma opção:");
export const vendasMenu = new Menu("Menu de Vendas:");
export const suporteMenu = new Menu("Menu de Suporte:");

// Configurando opções
atendimentoMenu.addOption("1", vendasMenu);
atendimentoMenu.addOption("2", suporteMenu);
vendasMenu.addOption("1", async (session) => {
    return { msg: "Você escolheu Vendas - Produto A" };
});
vendasMenu.addOption("2", async (session) => {
    return { msg: "Você escolheu Vendas - Produto B" };
});
suporteMenu.addOption("1", async (session) => {
    return { msg: "Suporte Técnico selecionado" };
});

// Exportar menus para index.mjs
export const menus = { atendimentoMenu, vendasMenu, suporteMenu };
