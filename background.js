// Create right-click context menu item
browser.contextMenus.create({
  id: "add-lens-annotation",
  title: "📌 Add Lens Annotation Here",
  contexts: ["all"]
});

// When user clicks the context menu item, tell content script to open annotation modal
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "add-lens-annotation") {
    browser.tabs.sendMessage(tab.id, {
      type: "OPEN_COORDINATE_ANNOTATION"
    });
  }
});
