//Витрины.

//Книга из внешней витрины, которой нет в библиотеке: ведёт на сайт источника
export function isExternalOnly(book = {}) {
    return book.discoveryMissingLocal === true;
}
