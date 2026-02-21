// Create right-click context menu item
browser.contextMenus.create({
  id: "add-annote-annotation",
  title: "📌 Add Annote Annotation Here",
  contexts: ["all"]
});

// When user clicks the context menu item, tell content script to open coordinate annotation
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "add-annote-annotation") {
    browser.tabs.sendMessage(tab.id, {
      type: "OPEN_COORDINATE_ANNOTATION"
    });
  }
});
