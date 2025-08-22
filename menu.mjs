export class Menu {
    constructor(title, options = {}) {
        this.title = title;
        this.options = options; // { "1": "SubMenu" ou callback }
    }

    addOption(number, action) {
        this.options[number] = action;
    }

    async handleInput(input, session) {
        const action = this.options[input];
        if (!action) return { msg: "Opção inválida. Digite novamente." };

        if (action instanceof Menu) {
            session.currentMenu = action;
            return { msg: action.title };
        } else if (typeof action === "function") {
            return await action(session);
        }
    }

    getText() {
        let text = this.title + "\n";
        for (const key in this.options) {
            const option = this.options[key];
            text += `${key} - ${option.title ?? option.name ?? "Ação"}\n`;
        }
        return text;
    }
}
