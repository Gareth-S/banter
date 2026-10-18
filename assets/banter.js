
const usedPhrases = new Set();

const app = document.getElementById("app");
const editModeBtn = document.getElementById("editModeBtn");

let categories = [];

async function loadCategories() {
    try {
        const response = await fetch("data/categories.json");

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        categories = await response.json();
        showHome();
    } catch (error) {
        console.error("Banter:", error);
        app.textContent = "Unable to load categories. Check the JSON file.";
    }
}

function showHome() {
    app.replaceChildren();

    const heading = document.createElement("h2");
    heading.textContent = "Choose a category";
    app.appendChild(heading);

    categories.forEach(category => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "category";
        button.textContent = category.name;

        button.addEventListener("click", () => {
            showPhrases(category);
        });

        app.appendChild(button);
    });
}

async function showPhrases(category) {
    app.replaceChildren();

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.textContent = "← Home";
    backButton.addEventListener("click", showHome);
    app.appendChild(backButton);

    const heading = document.createElement("h2");
    heading.textContent = category.name;
    app.appendChild(heading);

    try {
        const response = await fetch(`data/${category.file}`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const phrases = await response.json();

        phrases.forEach(phrase => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "phrase";
            button.textContent = phrase.text;

            if (usedPhrases.has(phrase.id)) {
                button.classList.add("used");
                button.disabled = true;
            }

            button.addEventListener("click", () => {
                usedPhrases.add(phrase.id);
                showHome();
            });

            app.appendChild(button);
        });
    } catch (error) {
        console.error("Banter:", error);

        const message = document.createElement("p");
        message.textContent =
            "Unable to load phrases. Check the category's JSON file.";

        app.appendChild(message);
    }
}

// Editing will be implemented in the next stage.
if (editModeBtn) {
    editModeBtn.disabled = true;
    editModeBtn.title = "Edit mode will be added next";
}

document.addEventListener("DOMContentLoaded", loadCategories);
